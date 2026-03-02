const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/classchat";
const JWT_SECRET = process.env.JWT_SECRET || "change-this-in-production";
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
const MAX_DATAURL_LENGTH = 8 * 1024 * 1024;

const app = express();
app.use(
  cors({
    origin: CLIENT_ORIGIN === "*" ? true : CLIENT_ORIGIN,
  })
);
app.use(express.json({ limit: "8mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN === "*" ? "*" : CLIENT_ORIGIN },
  maxHttpBufferSize: 10 * 1024 * 1024,
});

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
  })
  .catch((error) => {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  });

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

const groupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }],
    admins: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }],
  },
  { timestamps: true }
);

const messageSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    group: { type: mongoose.Schema.Types.ObjectId, ref: "Group" },
    text: { type: String, trim: true, default: "" },
    attachment: {
      name: { type: String, trim: true },
      mimeType: { type: String, trim: true },
      size: { type: Number },
      dataUrl: { type: String },
    },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: "Message" },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    reactions: [
      {
        emoji: { type: String, trim: true },
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      },
    ],
    editedAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

messageSchema.index({ sender: 1, receiver: 1, createdAt: 1 });
messageSchema.index({ group: 1, createdAt: 1 });

const User = mongoose.model("User", userSchema);
const Group = mongoose.model("Group", groupSchema);
const Message = mongoose.model("Message", messageSchema);

const onlineUsers = new Set();

const signToken = (user) =>
  jwt.sign({ userId: user._id.toString(), email: user.email }, JWT_SECRET, { expiresIn: "7d" });

const normalizeUser = (user) => ({
  id: user._id.toString(),
  name: user.name,
  email: user.email,
});

const getRoleFor = (group, userId) => {
  if (group.createdBy.toString() === userId) return "owner";
  if (group.admins.map((item) => item.toString()).includes(userId)) return "admin";
  return "member";
};

const normalizeGroup = (group, currentUserId) => ({
  id: group._id.toString(),
  name: group.name,
  createdBy: group.createdBy.toString(),
  members: group.members.map((member) => member.toString()),
  admins: group.admins.map((item) => item.toString()),
  memberCount: group.members.length,
  myRole: getRoleFor(group, currentUserId),
});

const normalizeMessage = (message) => ({
  id: message._id.toString(),
  sender: message.sender.toString(),
  receiver: message.receiver ? message.receiver.toString() : null,
  group: message.group ? message.group.toString() : null,
  text: message.deletedAt ? "This message was deleted" : message.text,
  attachment: message.deletedAt ? null : message.attachment?.name ? message.attachment : null,
  replyTo: message.replyTo ? message.replyTo.toString() : null,
  readBy: (message.readBy || []).map((id) => id.toString()),
  reactions: (message.reactions || []).map((item) => ({
    emoji: item.emoji,
    user: item.user.toString(),
  })),
  editedAt: message.editedAt || null,
  deletedAt: message.deletedAt || null,
  createdAt: message.createdAt,
});

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Missing token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};

const broadcastPresence = () => {
  io.emit("presence:update", Array.from(onlineUsers));
};

const trimAttachment = (attachment) => {
  if (!attachment || !attachment.name || !attachment.dataUrl) return undefined;
  const size = Number(attachment.size || 0);
  const dataUrl = String(attachment.dataUrl || "");
  if (size > MAX_ATTACHMENT_SIZE || dataUrl.length > MAX_DATAURL_LENGTH) {
    throw new Error("Attachment too large");
  }
  return {
    name: String(attachment.name).slice(0, 120),
    mimeType: String(attachment.mimeType || "").slice(0, 120),
    size,
    dataUrl,
  };
};

app.get("/api/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password are required" });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) return res.status(409).json({ message: "Email already registered" });

    const user = await User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(password, 10),
    });

    return res.status(201).json({ token: signToken(user), user: normalizeUser(user) });
  } catch (error) {
    return res.status(500).json({ message: "Registration failed", error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user) return res.status(401).json({ message: "Invalid email or password" });
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) return res.status(401).json({ message: "Invalid email or password" });

    return res.json({ token: signToken(user), user: normalizeUser(user) });
  } catch (error) {
    return res.status(500).json({ message: "Login failed", error: error.message });
  }
});

app.get("/api/users", authMiddleware, async (req, res) => {
  try {
    const users = await User.find({ _id: { $ne: req.user.userId } }).select("_id name email");
    return res.json(
      users.map((user) => ({
        ...normalizeUser(user),
        isOnline: onlineUsers.has(user._id.toString()),
      }))
    );
  } catch (error) {
    return res.status(500).json({ message: "Could not fetch users", error: error.message });
  }
});

app.get("/api/messages/:userId", authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const myId = req.user.userId;

    const messages = await Message.find({
      $or: [
        { sender: myId, receiver: userId },
        { sender: userId, receiver: myId },
      ],
    })
      .sort({ createdAt: 1 })
      .select(
        "_id sender receiver group text attachment replyTo readBy reactions editedAt deletedAt createdAt"
      );

    return res.json(messages.map(normalizeMessage));
  } catch (error) {
    return res.status(500).json({ message: "Could not fetch messages", error: error.message });
  }
});

app.get("/api/groups", authMiddleware, async (req, res) => {
  try {
    const groups = await Group.find({ members: req.user.userId }).sort({ updatedAt: -1 });
    return res.json(groups.map((group) => normalizeGroup(group, req.user.userId)));
  } catch (error) {
    return res.status(500).json({ message: "Could not fetch groups", error: error.message });
  }
});

app.post("/api/groups", authMiddleware, async (req, res) => {
  try {
    const { name, memberIds } = req.body;
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ message: "Group name must be at least 2 characters" });
    }

    const requestedMembers = Array.isArray(memberIds) ? memberIds : [];
    const members = Array.from(new Set([req.user.userId, ...requestedMembers])).filter(Boolean);
    if (members.length < 2) return res.status(400).json({ message: "A group needs at least 2 members" });

    const validUsersCount = await User.countDocuments({ _id: { $in: members } });
    if (validUsersCount !== members.length) {
      return res.status(400).json({ message: "One or more members are invalid" });
    }

    const group = await Group.create({
      name: String(name).trim(),
      createdBy: req.user.userId,
      members,
      admins: [req.user.userId],
    });

    const roomId = `group:${group._id.toString()}`;
    members.forEach((memberId) => {
      io.to(memberId.toString()).socketsJoin(roomId);
      io.to(memberId.toString()).emit("group:created", normalizeGroup(group, memberId.toString()));
    });

    return res.status(201).json(normalizeGroup(group, req.user.userId));
  } catch (error) {
    return res.status(500).json({ message: "Could not create group", error: error.message });
  }
});

app.patch("/api/groups/:groupId/members", authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { action, memberId } = req.body;
    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    const myId = req.user.userId;
    const memberExists = group.members.map((id) => id.toString()).includes(memberId);
    const amOwner = group.createdBy.toString() === myId;
    const amAdmin = group.admins.map((id) => id.toString()).includes(myId);
    if (!amOwner && !amAdmin) return res.status(403).json({ message: "Only admins can manage members" });

    if (action === "add") {
      if (!memberId) return res.status(400).json({ message: "memberId is required" });
      const user = await User.findById(memberId);
      if (!user) return res.status(404).json({ message: "User not found" });
      if (!memberExists) group.members.push(memberId);
      await group.save();
      io.to(memberId).socketsJoin(`group:${group.id}`);
      io.to(memberId).emit("group:created", normalizeGroup(group, memberId));
    }

    if (action === "remove") {
      if (!memberId) return res.status(400).json({ message: "memberId is required" });
      if (group.createdBy.toString() === memberId) {
        return res.status(400).json({ message: "Owner cannot be removed" });
      }
      group.members = group.members.filter((id) => id.toString() !== memberId);
      group.admins = group.admins.filter((id) => id.toString() !== memberId);
      await group.save();
      io.to(memberId).socketsLeave(`group:${group.id}`);
      io.to(memberId).emit("group:removed", group.id);
    }

    if (action === "promote") {
      if (!amOwner) return res.status(403).json({ message: "Only owner can promote admin" });
      if (!memberExists) return res.status(400).json({ message: "User is not a member" });
      if (!group.admins.map((id) => id.toString()).includes(memberId)) group.admins.push(memberId);
      await group.save();
    }

    if (action === "demote") {
      if (!amOwner) return res.status(403).json({ message: "Only owner can demote admin" });
      if (group.createdBy.toString() === memberId) {
        return res.status(400).json({ message: "Owner role cannot be changed" });
      }
      group.admins = group.admins.filter((id) => id.toString() !== memberId);
      await group.save();
    }

    group.members.forEach((member) => {
      io.to(member.toString()).emit("group:updated", normalizeGroup(group, member.toString()));
    });

    return res.json(normalizeGroup(group, req.user.userId));
  } catch (error) {
    return res.status(500).json({ message: "Could not update group members", error: error.message });
  }
});

app.get("/api/group-messages/:groupId", authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;
    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });
    if (!group.members.map((id) => id.toString()).includes(req.user.userId)) {
      return res.status(403).json({ message: "Not a member of this group" });
    }

    const messages = await Message.find({ group: groupId })
      .sort({ createdAt: 1 })
      .select(
        "_id sender receiver group text attachment replyTo readBy reactions editedAt deletedAt createdAt"
      );

    return res.json(messages.map(normalizeMessage));
  } catch (error) {
    return res.status(500).json({ message: "Could not fetch group messages", error: error.message });
  }
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Unauthorized"));
    socket.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  const userId = socket.user.userId;
  socket.join(userId);
  onlineUsers.add(userId);
  broadcastPresence();

  Group.find({ members: userId })
    .select("_id")
    .then((groups) => groups.forEach((group) => socket.join(`group:${group._id.toString()}`)))
    .catch(() => {});

  socket.on("send_private_message", async ({ to, text, attachment, replyTo }) => {
    try {
      const content = String(text || "").trim();
      const cleanAttachment = trimAttachment(attachment);
      if (!to || (!content && !cleanAttachment)) return;

      const message = await Message.create({
        sender: userId,
        receiver: to,
        text: content,
        attachment: cleanAttachment,
        replyTo: replyTo || undefined,
        readBy: [userId],
      });

      const payload = normalizeMessage(message);
      io.to(userId).emit("receive_private_message", payload);
      io.to(to).emit("receive_private_message", payload);
    } catch (error) {
      socket.emit(
        "chat:error",
        error.message === "Attachment too large"
          ? "Attachment is too large. Max 5 MB."
          : "Failed to send message"
      );
    }
  });

  socket.on("send_group_message", async ({ groupId, text, attachment, replyTo }) => {
    try {
      const content = String(text || "").trim();
      const cleanAttachment = trimAttachment(attachment);
      if (!groupId || (!content && !cleanAttachment)) return;

      const group = await Group.findById(groupId).select("_id members");
      if (!group) return socket.emit("chat:error", "Group not found");
      if (!group.members.map((id) => id.toString()).includes(userId)) {
        return socket.emit("chat:error", "Not a member of this group");
      }

      const message = await Message.create({
        sender: userId,
        group: groupId,
        text: content,
        attachment: cleanAttachment,
        replyTo: replyTo || undefined,
        readBy: [userId],
      });

      io.to(`group:${groupId}`).emit("receive_group_message", normalizeMessage(message));
    } catch (error) {
      socket.emit(
        "chat:error",
        error.message === "Attachment too large"
          ? "Attachment is too large. Max 5 MB."
          : "Failed to send group message"
      );
    }
  });

  socket.on("mark_read", async ({ targetType, targetId }) => {
    try {
      if (!targetType || !targetId) return;

      if (targetType === "direct") {
        const unread = await Message.find({
          sender: targetId,
          receiver: userId,
          readBy: { $ne: userId },
          deletedAt: null,
        });
        if (unread.length === 0) return;

        const ids = unread.map((item) => item._id);
        await Message.updateMany({ _id: { $in: ids } }, { $addToSet: { readBy: userId } });
        io.to(targetId).emit("messages:read", {
          targetType: "direct",
          targetId: userId,
          messageIds: ids.map((id) => id.toString()),
          readerId: userId,
        });
        io.to(userId).emit("messages:read", {
          targetType: "direct",
          targetId,
          messageIds: ids.map((id) => id.toString()),
          readerId: userId,
        });
      }

      if (targetType === "group") {
        const unread = await Message.find({
          group: targetId,
          sender: { $ne: userId },
          readBy: { $ne: userId },
          deletedAt: null,
        });
        if (unread.length === 0) return;
        const ids = unread.map((item) => item._id);
        await Message.updateMany({ _id: { $in: ids } }, { $addToSet: { readBy: userId } });
        io.to(`group:${targetId}`).emit("messages:read", {
          targetType: "group",
          targetId,
          messageIds: ids.map((id) => id.toString()),
          readerId: userId,
        });
      }
    } catch {}
  });

  socket.on("edit_message", async ({ messageId, text }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message || message.sender.toString() !== userId || message.deletedAt) return;
      message.text = String(text || "").trim();
      message.editedAt = new Date();
      await message.save();

      const payload = normalizeMessage(message);
      if (message.group) {
        io.to(`group:${message.group.toString()}`).emit("message:updated", payload);
      } else if (message.receiver) {
        io.to(userId).emit("message:updated", payload);
        io.to(message.receiver.toString()).emit("message:updated", payload);
      }
    } catch {}
  });

  socket.on("delete_message", async ({ messageId }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message || message.sender.toString() !== userId || message.deletedAt) return;
      message.deletedAt = new Date();
      message.text = "";
      message.attachment = undefined;
      await message.save();

      const payload = normalizeMessage(message);
      if (message.group) {
        io.to(`group:${message.group.toString()}`).emit("message:updated", payload);
      } else if (message.receiver) {
        io.to(userId).emit("message:updated", payload);
        io.to(message.receiver.toString()).emit("message:updated", payload);
      }
    } catch {}
  });

  socket.on("typing", ({ targetType, targetId, isTyping }) => {
    if (!targetType || !targetId) return;

    if (targetType === "direct") {
      io.to(targetId).emit("typing:update", {
        targetType,
        targetId,
        from: userId,
        isTyping: Boolean(isTyping),
      });
      return;
    }

    if (targetType === "group") {
      socket.to(`group:${targetId}`).emit("typing:update", {
        targetType,
        targetId,
        from: userId,
        isTyping: Boolean(isTyping),
      });
    }
  });

  socket.on("toggle_reaction", async ({ messageId, emoji }) => {
    try {
      const safeEmoji = String(emoji || "").slice(0, 8);
      if (!messageId || !safeEmoji) return;

      const message = await Message.findById(messageId);
      if (!message || message.deletedAt) return;

      const userIdStr = userId.toString();
      const currentReactions = Array.isArray(message.reactions) ? message.reactions : [];
      const existingIndex = currentReactions.findIndex(
        (item) => item.user.toString() === userIdStr
      );

      if (existingIndex >= 0 && currentReactions[existingIndex].emoji === safeEmoji) {
        currentReactions.splice(existingIndex, 1);
      } else if (existingIndex >= 0) {
        currentReactions[existingIndex].emoji = safeEmoji;
      } else {
        currentReactions.push({ emoji: safeEmoji, user: userId });
      }

      message.reactions = currentReactions;
      await message.save();

      const payload = normalizeMessage(message);
      if (message.group) {
        io.to(`group:${message.group.toString()}`).emit("message:updated", payload);
      } else if (message.receiver) {
        io.to(message.sender.toString()).emit("message:updated", payload);
        io.to(message.receiver.toString()).emit("message:updated", payload);
      }
    } catch {}
  });

  socket.on("disconnect", () => {
    const room = io.sockets.adapter.rooms.get(userId);
    if (!room || room.size === 0) {
      onlineUsers.delete(userId);
      broadcastPresence();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
