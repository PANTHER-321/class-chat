
import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import "./App.css";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";
const STORAGE = {
  token: "classchat_token",
  user: "classchat_user",
  theme: "classchat_theme",
  accent: "classchat_accent",
  density: "classchat_density",
  wallpaper: "classchat_wallpaper",
  favorites: "classchat_favorites",
};

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const QUICK_EMOJIS = [
  "\u{1F600}",
  "\u{1F602}",
  "\u{1F44D}",
  "\u{1F525}",
  "\u{1F3AF}",
  "\u{1F44F}",
  "\u{2764}\u{FE0F}",
  "\u{1F64F}",
  "\u{1F389}",
  "\u{1F44C}",
  "\u{1F60E}",
  "\u{1F31F}",
];
const REACTION_EMOJIS = [
  "\u{1F44D}",
  "\u{2764}\u{FE0F}",
  "\u{1F602}",
  "\u{1F62E}",
  "\u{1F389}",
  "\u{1F44F}",
  "\u{1F525}",
  "\u{1F60D}",
];
const SUPPORTED_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
];

const api = axios.create({ baseURL: API_BASE_URL });

const parseJson = (key, fallback) => {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const formatTime = (value) =>
  value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

const formatBytes = (value = 0) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const isImage = (mimeType = "") => mimeType.startsWith("image/");

const isSupportedFile = (file) => {
  if (!file) return false;
  if (file.type && file.type.length > 0) return true;
  const lower = String(file.name || "").toLowerCase();
  return SUPPORTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

const readFileWithProgress = (file, onProgress) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("read-error"));
    reader.readAsDataURL(file);
  });

function App() {
  const [token, setToken] = useState(localStorage.getItem(STORAGE.token) || "");
  const [currentUser, setCurrentUser] = useState(parseJson(STORAGE.user, null));
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [authError, setAuthError] = useState("");

  const [theme, setTheme] = useState(localStorage.getItem(STORAGE.theme) || "light");
  const [accent, setAccent] = useState(localStorage.getItem(STORAGE.accent) || "emerald");
  const [density, setDensity] = useState(localStorage.getItem(STORAGE.density) || "comfortable");
  const [wallpaper, setWallpaper] = useState(localStorage.getItem(STORAGE.wallpaper) || "paper");
  const [favorites, setFavorites] = useState(parseJson(STORAGE.favorites, { direct: [], group: [] }));

  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [onlineIds, setOnlineIds] = useState([]);
  const [unreadDirect, setUnreadDirect] = useState({});
  const [unreadGroup, setUnreadGroup] = useState({});

  const [mode, setMode] = useState("direct");
  const [sidebarFilter, setSidebarFilter] = useState("all");
  const [selectedDirectId, setSelectedDirectId] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [directMessages, setDirectMessages] = useState([]);
  const [groupMessages, setGroupMessages] = useState([]);
  const [typing, setTyping] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");

  const [message, setMessage] = useState("");
  const [attachment, setAttachment] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [replyTarget, setReplyTarget] = useState(null);
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingText, setEditingText] = useState("");

  const [showEmojiPopover, setShowEmojiPopover] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showManageModal, setShowManageModal] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState([]);
  const [manageAction, setManageAction] = useState("add");
  const [manageMemberId, setManageMemberId] = useState("");

  const [openMessageMenuId, setOpenMessageMenuId] = useState(null);
  const [openReactionPickerForId, setOpenReactionPickerForId] = useState(null);
  const [hoveredMessageId, setHoveredMessageId] = useState(null);

  const socketRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const composerRef = useRef(null);
  const searchRef = useRef(null);

  const selectedDirect = useMemo(
    () => users.find((user) => user.id === selectedDirectId) || null,
    [users, selectedDirectId]
  );
  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) || null,
    [groups, selectedGroupId]
  );

  const usersById = useMemo(() => {
    const map = {};
    users.forEach((user) => {
      map[user.id] = user;
    });
    if (currentUser) {
      map[currentUser.id] = currentUser;
    }
    return map;
  }, [users, currentUser]);

  const messages = mode === "direct" ? directMessages : groupMessages;

  const shownMessages = useMemo(() => {
    if (!search.trim()) return messages;
    const value = search.toLowerCase();
    return messages.filter((item) => (item.text || "").toLowerCase().includes(value));
  }, [messages, search]);

  const sharedFiles = useMemo(
    () => messages.filter((item) => item.attachment).map((item) => item.attachment),
    [messages]
  );

  const sortedUsers = useMemo(() => {
    const favoriteSet = new Set(favorites.direct);
    let list = [...users].sort(
      (a, b) =>
        Number(favoriteSet.has(b.id)) - Number(favoriteSet.has(a.id)) ||
        a.name.localeCompare(b.name)
    );
    if (sidebarFilter === "unread") {
      list = list.filter((user) => (unreadDirect[user.id] || 0) > 0);
    }
    if (sidebarFilter === "favorites") {
      list = list.filter((user) => favoriteSet.has(user.id));
    }
    return list;
  }, [users, favorites, sidebarFilter, unreadDirect]);

  const sortedGroups = useMemo(() => {
    const favoriteSet = new Set(favorites.group);
    let list = [...groups].sort(
      (a, b) =>
        Number(favoriteSet.has(b.id)) - Number(favoriteSet.has(a.id)) ||
        a.name.localeCompare(b.name)
    );
    if (sidebarFilter === "unread") {
      list = list.filter((group) => (unreadGroup[group.id] || 0) > 0);
    }
    if (sidebarFilter === "favorites") {
      list = list.filter((group) => favoriteSet.has(group.id));
    }
    return list;
  }, [groups, favorites, sidebarFilter, unreadGroup]);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-accent", accent);
    document.documentElement.setAttribute("data-density", density);
    document.documentElement.setAttribute("data-wallpaper", wallpaper);

    localStorage.setItem(STORAGE.theme, theme);
    localStorage.setItem(STORAGE.accent, accent);
    localStorage.setItem(STORAGE.density, density);
    localStorage.setItem(STORAGE.wallpaper, wallpaper);
    localStorage.setItem(STORAGE.favorites, JSON.stringify(favorites));
  }, [theme, accent, density, wallpaper, favorites]);

  useEffect(() => {
    if (!composerRef.current) return;
    composerRef.current.style.height = "0px";
    composerRef.current.style.height = `${Math.min(composerRef.current.scrollHeight, 120)}px`;
  }, [message]);

  useEffect(() => {
    const onMouseDown = (event) => {
      const target = event.target;
      if (!target.closest(".message-menu-root")) {
        setOpenMessageMenuId(null);
        setOpenReactionPickerForId(null);
      }
      if (!target.closest(".emoji-popover") && !target.closest(".emoji-toggle")) {
        setShowEmojiPopover(false);
      }
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setOpenMessageMenuId(null);
        setOpenReactionPickerForId(null);
        setShowSettingsModal(false);
        setShowEmojiPopover(false);
        setShowGroupModal(false);
        setShowManageModal(false);
      }
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!token || !currentUser) return;
    const socket = io(API_BASE_URL, { auth: { token } });
    socketRef.current = socket;

    socket.on("presence:update", setOnlineIds);
    socket.on("group:created", (group) =>
      setGroups((prev) => [group, ...prev.filter((item) => item.id !== group.id)])
    );
    socket.on("group:updated", (group) =>
      setGroups((prev) => [group, ...prev.filter((item) => item.id !== group.id)])
    );
    socket.on("group:removed", (groupId) =>
      setGroups((prev) => prev.filter((group) => group.id !== groupId))
    );

    socket.on("typing:update", ({ targetType, targetId, from, isTyping }) => {
      if (!isTyping) {
        setTyping("");
        return;
      }

      if (targetType === "direct" && mode === "direct" && selectedDirectId === from) {
        setTyping(`${usersById[from]?.name || "User"} is typing`);
      }
      if (targetType === "group" && mode === "group" && selectedGroupId === targetId) {
        setTyping(`${usersById[from]?.name || "User"} is typing`);
      }
    });

    socket.on("receive_private_message", (item) => {
      const isRelevant =
        (item.sender === selectedDirectId && item.receiver === currentUser.id) ||
        (item.sender === currentUser.id && item.receiver === selectedDirectId);

      if (isRelevant) {
        setDirectMessages((prev) => [...prev, item]);
      } else if (item.sender !== currentUser.id) {
        setUnreadDirect((prev) => ({ ...prev, [item.sender]: (prev[item.sender] || 0) + 1 }));
      }
    });

    socket.on("receive_group_message", (item) => {
      if (item.group === selectedGroupId) {
        setGroupMessages((prev) => [...prev, item]);
      } else if (item.sender !== currentUser.id) {
        setUnreadGroup((prev) => ({ ...prev, [item.group]: (prev[item.group] || 0) + 1 }));
      }
    });

    socket.on("messages:read", ({ messageIds, readerId }) => {
      const patch = (list) =>
        list.map((item) =>
          messageIds.includes(item.id)
            ? { ...item, readBy: [...new Set([...(item.readBy || []), readerId])] }
            : item
        );
      setDirectMessages((prev) => patch(prev));
      setGroupMessages((prev) => patch(prev));
    });

    socket.on("message:updated", (payload) => {
      const patch = (list) => list.map((item) => (item.id === payload.id ? payload : item));
      setDirectMessages((prev) => patch(prev));
      setGroupMessages((prev) => patch(prev));
    });

    socket.on("chat:error", setStatus);
    socket.on("connect_error", () => setStatus("Socket connection failed"));
    socket.on("disconnect", () => setStatus("Disconnected. Reconnecting..."));

    return () => socket.disconnect();
  }, [token, currentUser, mode, selectedDirectId, selectedGroupId, usersById]);

  useEffect(() => {
    if (!token) return;
    const headers = { headers: { Authorization: `Bearer ${token}` } };
    api.get("/api/users", headers).then((response) => setUsers(response.data)).catch(() => {});
    api.get("/api/groups", headers).then((response) => setGroups(response.data)).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!selectedDirectId && users.length > 0) setSelectedDirectId(users[0].id);
  }, [users, selectedDirectId]);

  useEffect(() => {
    if (!selectedGroupId && groups.length > 0) setSelectedGroupId(groups[0].id);
  }, [groups, selectedGroupId]);

  useEffect(() => {
    if (!token || mode !== "direct" || !selectedDirectId) {
      setDirectMessages([]);
      return;
    }

    api
      .get(`/api/messages/${selectedDirectId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => {
        setDirectMessages(response.data);
        setUnreadDirect((prev) => ({ ...prev, [selectedDirectId]: 0 }));
      })
      .catch(() => {});
  }, [token, mode, selectedDirectId]);

  useEffect(() => {
    if (!token || mode !== "group" || !selectedGroupId) {
      setGroupMessages([]);
      return;
    }

    api
      .get(`/api/group-messages/${selectedGroupId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((response) => {
        setGroupMessages(response.data);
        setUnreadGroup((prev) => ({ ...prev, [selectedGroupId]: 0 }));
      })
      .catch(() => {});
  }, [token, mode, selectedGroupId]);

  useEffect(() => {
    if (!socketRef.current) return;
    if (mode === "direct" && selectedDirectId) {
      socketRef.current.emit("mark_read", { targetType: "direct", targetId: selectedDirectId });
    }
    if (mode === "group" && selectedGroupId) {
      socketRef.current.emit("mark_read", { targetType: "group", targetId: selectedGroupId });
    }
  }, [mode, selectedDirectId, selectedGroupId, directMessages.length, groupMessages.length]);

  const emitTyping = (isTyping) => {
    if (!socketRef.current) return;
    if (mode === "direct" && selectedDirectId) {
      socketRef.current.emit("typing", { targetType: "direct", targetId: selectedDirectId, isTyping });
    }
    if (mode === "group" && selectedGroupId) {
      socketRef.current.emit("typing", { targetType: "group", targetId: selectedGroupId, isTyping });
    }
  };

  const handleAuth = async (event) => {
    event.preventDefault();
    setAuthError("");

    const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
    const payload =
      authMode === "login"
        ? { email: authForm.email, password: authForm.password }
        : authForm;

    try {
      const response = await api.post(endpoint, payload);
      localStorage.setItem(STORAGE.token, response.data.token);
      localStorage.setItem(STORAGE.user, JSON.stringify(response.data.user));
      setToken(response.data.token);
      setCurrentUser(response.data.user);
      setAuthForm({ name: "", email: "", password: "" });
    } catch (error) {
      setAuthError(error.response?.data?.message || "Authentication failed");
    }
  };

  const logout = () => {
    localStorage.removeItem(STORAGE.token);
    localStorage.removeItem(STORAGE.user);
    setToken("");
    setCurrentUser(null);
  };

  const handleInput = (value) => {
    setMessage(value);
    emitTyping(true);
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => emitTyping(false), 800);
  };

  const attachFile = async (file) => {
    if (!file) return;
    if (!isSupportedFile(file)) {
      setStatus("File type not supported");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setStatus("Max file size is 5 MB");
      return;
    }

    try {
      setUploadProgress(1);
      const dataUrl = await readFileWithProgress(file, setUploadProgress);
      setAttachment({ name: file.name, mimeType: file.type, size: file.size, dataUrl });
      setUploadProgress(100);
      setTimeout(() => setUploadProgress(0), 400);
    } catch {
      setStatus("Could not read file");
      setUploadProgress(0);
    }
  };

  const sendMessage = () => {
    const text = message.trim();
    if (!socketRef.current || (!text && !attachment)) return;

    const payload = { text, attachment, replyTo: replyTarget?.id || null };
    if (mode === "direct" && selectedDirectId) {
      socketRef.current.emit("send_private_message", { ...payload, to: selectedDirectId });
    }
    if (mode === "group" && selectedGroupId) {
      socketRef.current.emit("send_group_message", { ...payload, groupId: selectedGroupId });
    }

    setMessage("");
    setAttachment(null);
    setReplyTarget(null);
    setShowEmojiPopover(false);
    emitTyping(false);
  };

  const toggleFavorite = () => {
    if (mode === "direct" && selectedDirectId) {
      setFavorites((prev) => ({
        ...prev,
        direct: prev.direct.includes(selectedDirectId)
          ? prev.direct.filter((item) => item !== selectedDirectId)
          : [...prev.direct, selectedDirectId],
      }));
    }
    if (mode === "group" && selectedGroupId) {
      setFavorites((prev) => ({
        ...prev,
        group: prev.group.includes(selectedGroupId)
          ? prev.group.filter((item) => item !== selectedGroupId)
          : [...prev.group, selectedGroupId],
      }));
    }
  };

  const exportChat = () => {
    const lines = messages.map(
      (item) =>
        `${formatTime(item.createdAt)} ${usersById[item.sender]?.name || "User"}: ${
          item.text || "[Attachment]"
        }`
    );
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `chat-${new Date().toISOString().slice(0, 10)}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const runMessageAction = (action, item) => {
    if (action === "reply") {
      setReplyTarget(item);
    }
    if (action === "edit") {
      setEditingMessageId(item.id);
      setEditingText(item.text || "");
    }
    if (action === "delete") {
      socketRef.current?.emit("delete_message", { messageId: item.id });
    }
    setOpenMessageMenuId(null);
    if (action !== "react") {
      setOpenReactionPickerForId(null);
    }
  };

  const toggleReaction = (messageId, emoji) => {
    socketRef.current?.emit("toggle_reaction", { messageId, emoji });
    setOpenReactionPickerForId(null);
    setOpenMessageMenuId(null);
  };

  const messageReadState = (item) => {
    if (!item.receiver) return "";
    return (item.readBy || []).includes(item.receiver) ? "Read" : "Sent";
  };
  const submitGroupCreate = async () => {
    try {
      const response = await api.post(
        "/api/groups",
        { name: groupName, memberIds: groupMembers },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setGroups((prev) => [response.data, ...prev.filter((item) => item.id !== response.data.id)]);
      setSelectedGroupId(response.data.id);
      setMode("group");
      setShowGroupModal(false);
      setGroupName("");
      setGroupMembers([]);
    } catch {
      setStatus("Failed to create group");
    }
  };

  const submitGroupManage = async () => {
    if (!selectedGroupId || !manageMemberId) return;
    try {
      const response = await api.patch(
        `/api/groups/${selectedGroupId}/members`,
        { action: manageAction, memberId: manageMemberId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setGroups((prev) => [response.data, ...prev.filter((item) => item.id !== response.data.id)]);
      setShowManageModal(false);
      setManageMemberId("");
    } catch {
      setStatus("Group update failed");
    }
  };

  if (!token || !currentUser) {
    return (
      <main className="auth-bg">
        <section className="auth-card">
          <div className="logo-badge">CC</div>
          <h1>Class Chat</h1>
          <p>Realtime classroom chat</p>

          <div className="auth-tabs">
            <button className={authMode === "login" ? "active" : ""} onClick={() => setAuthMode("login")} type="button">
              Login
            </button>
            <button className={authMode === "register" ? "active" : ""} onClick={() => setAuthMode("register")} type="button">
              Register
            </button>
          </div>

          <form className="auth-form" onSubmit={handleAuth}>
            {authMode === "register" && (
              <input
                placeholder="Full name"
                value={authForm.name}
                onChange={(event) =>
                  setAuthForm((prev) => ({ ...prev, name: event.target.value }))
                }
                required
              />
            )}
            <input
              type="email"
              placeholder="Email"
              value={authForm.email}
              onChange={(event) =>
                setAuthForm((prev) => ({ ...prev, email: event.target.value }))
              }
              required
            />
            <input
              type="password"
              placeholder="Password"
              minLength={6}
              value={authForm.password}
              onChange={(event) =>
                setAuthForm((prev) => ({ ...prev, password: event.target.value }))
              }
              required
            />
            <button type="submit">{authMode === "login" ? "Sign in" : "Create account"}</button>
          </form>

          {authError && <p className="error-text">{authError}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="chat-shell">
      <aside className="sidebar">
        <header className="sidebar-head">
          <div>
            <h2>Class Chat</h2>
            <p>{currentUser.name}</p>
          </div>
          <button type="button" onClick={logout}>
            Logout
          </button>
        </header>

        <div className="mode-tabs">
          <button className={mode === "direct" ? "active" : ""} onClick={() => setMode("direct")} type="button">
            Direct
          </button>
          <button className={mode === "group" ? "active" : ""} onClick={() => setMode("group")} type="button">
            Groups
          </button>
        </div>

        <div className="filter-chips">
          {["all", "unread", "favorites"].map((value) => (
            <button
              key={value}
              className={sidebarFilter === value ? "active" : ""}
              onClick={() => setSidebarFilter(value)}
              type="button"
            >
              {value}
            </button>
          ))}
        </div>

        {mode === "group" && (
          <div className="tool-row">
            <button onClick={() => setShowGroupModal(true)} type="button">
              + Group
            </button>
            {selectedGroup && (selectedGroup.myRole === "owner" || selectedGroup.myRole === "admin") && (
              <button onClick={() => setShowManageModal(true)} type="button">
                Manage
              </button>
            )}
          </div>
        )}

        <div className="chat-list">
          {(mode === "direct" ? sortedUsers : sortedGroups).map((item) => {
            const activeId = mode === "direct" ? selectedDirectId : selectedGroupId;
            const unreadCount = mode === "direct" ? unreadDirect[item.id] : unreadGroup[item.id];
            const favoriteSet = mode === "direct" ? favorites.direct : favorites.group;

            return (
              <button
                key={item.id}
                className={`chat-card ${activeId === item.id ? "selected" : ""}`}
                onClick={() => (mode === "direct" ? setSelectedDirectId(item.id) : setSelectedGroupId(item.id))}
                type="button"
              >
                <div>
                  <strong>{favoriteSet.includes(item.id) ? `? ${item.name}` : item.name}</strong>
                  <small>
                    {mode === "direct"
                      ? onlineIds.includes(item.id)
                        ? "Online"
                        : "Offline"
                      : item.myRole}
                  </small>
                </div>
                {(unreadCount || 0) > 0 && <span className="badge-pill">{unreadCount}</span>}
              </button>
            );
          })}
        </div>
      </aside>

      <section className="chat-main">
        <header className="chat-head">
          <div>
            <h3>{mode === "direct" ? selectedDirect?.name || "Select user" : selectedGroup?.name || "Select group"}</h3>
            <p className="typing-line">
              {typing || (mode === "group" ? `${selectedGroup?.memberCount || 0} members` : selectedDirect?.email || "Direct chat")}
            </p>
          </div>
          <div className="chat-head-tools">
            <input
              ref={searchRef}
              placeholder="Search..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button onClick={toggleFavorite} type="button">Fav</button>
            <button onClick={exportChat} type="button">Export</button>
            <button onClick={() => setShowSettingsModal(true)} type="button">Settings</button>
          </div>
        </header>

        <div
          className={`message-area ${dragging ? "dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            attachFile(event.dataTransfer.files?.[0]);
          }}
        >
          {dragging && <div className="drop-banner">Drop file to upload</div>}
          {shownMessages.length === 0 && <p className="info-line">No messages yet.</p>}

          {shownMessages.map((item) => {
            const mine = item.sender === currentUser.id;
            const reply = item.replyTo ? messages.find((messageItem) => messageItem.id === item.replyTo) : null;
            const reactions = (item.reactions || []).reduce((acc, reaction) => {
              acc[reaction.emoji] = (acc[reaction.emoji] || 0) + 1;
              return acc;
            }, {});

            return (
              <article
                key={item.id}
                className={`message-bubble ${mine ? "mine" : "theirs"}`}
                onMouseEnter={() => setHoveredMessageId(item.id)}
                onMouseLeave={() => setHoveredMessageId((prev) => (prev === item.id ? null : prev))}
              >
                <div className="message-top">
                  <span className="message-name">{mine ? "You" : usersById[item.sender]?.name || "User"}</span>
                  <div className="message-menu-root">
                    <button
                      className={`message-menu-trigger ${
                        hoveredMessageId === item.id || openMessageMenuId === item.id ? "visible" : ""
                      }`}
                      onClick={() =>
                        setOpenMessageMenuId((prev) => (prev === item.id ? null : item.id))
                      }
                      aria-label="Message options"
                      type="button"
                    >
                      {"\u25BE"}
                    </button>
                    {openMessageMenuId === item.id && (
                      <div className="message-menu">
                        <button onClick={() => runMessageAction("reply", item)} type="button">Reply</button>
                        {mine && (
                          <>
                            <button onClick={() => runMessageAction("edit", item)} type="button">Edit</button>
                            <button onClick={() => runMessageAction("delete", item)} type="button">Delete</button>
                          </>
                        )}
                        <button
                          onClick={() =>
                            setOpenReactionPickerForId((prev) => (prev === item.id ? null : item.id))
                          }
                          type="button"
                        >
                          React
                        </button>
                        {openReactionPickerForId === item.id && (
                          <div className="reaction-picker">
                            {REACTION_EMOJIS.map((emoji) => (
                              <button key={`${item.id}-${emoji}`} onClick={() => toggleReaction(item.id, emoji)} type="button">
                                {emoji}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {reply && (
                  <div className="reply-ref">
                    Reply to {usersById[reply.sender]?.name || "User"}: {reply.text || "Attachment"}
                  </div>
                )}
                {item.text && <p>{item.text}</p>}
                {item.attachment && (
                  <div className="file-card">
                    {isImage(item.attachment.mimeType) && (
                      <img src={item.attachment.dataUrl} alt={item.attachment.name} />
                    )}
                    <a href={item.attachment.dataUrl} download={item.attachment.name}>
                      {item.attachment.name}
                    </a>
                    <span>{formatBytes(item.attachment.size)}</span>
                  </div>
                )}

                <div className="meta-row">
                  <time>{formatTime(item.createdAt)}</time>
                  {item.editedAt && <span>edited</span>}
                  {mine && mode === "direct" && <span>{messageReadState(item)}</span>}
                </div>

                <div className="reaction-summary">
                  {Object.entries(reactions).map(([emoji, count]) => (
                    <span key={`${item.id}-${emoji}`} className="reaction-chip">
                      {emoji} {count}
                    </span>
                  ))}
                </div>
              </article>
            );
          })}
        </div>

        {replyTarget && (
          <div className="context-bar">
            <span>
              Replying to {usersById[replyTarget.sender]?.name || "User"}: {replyTarget.text || "Attachment"}
            </span>
            <button onClick={() => setReplyTarget(null)} type="button">Cancel</button>
          </div>
        )}

        {editingMessageId && (
          <div className="context-bar">
            <input value={editingText} onChange={(event) => setEditingText(event.target.value)} />
            <button
              onClick={() => {
                socketRef.current?.emit("edit_message", { messageId: editingMessageId, text: editingText.trim() });
                setEditingMessageId("");
                setEditingText("");
              }}
              type="button"
            >
              Save
            </button>
            <button
              onClick={() => {
                setEditingMessageId("");
                setEditingText("");
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        )}

        <footer className="composer">
          <label className="file-btn">
            +
            <input
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
              onChange={(event) => attachFile(event.target.files?.[0])}
            />
          </label>
          <textarea
            ref={composerRef}
            placeholder="Type a message..."
            value={message}
            onChange={(event) => handleInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
          />
          <button className="emoji-toggle" onClick={() => setShowEmojiPopover((prev) => !prev)} type="button">
            Emoji
          </button>
          <button onClick={sendMessage} type="button">Send</button>
        </footer>

        {showEmojiPopover && (
          <div className="emoji-popover">
            {QUICK_EMOJIS.map((emoji) => (
              <button key={emoji} onClick={() => handleInput(`${message}${emoji}`)} type="button">
                {emoji}
              </button>
            ))}
          </div>
        )}

        {uploadProgress > 0 && uploadProgress < 100 && (
          <div className="progress-wrap">
            <div className="progress-bar" style={{ width: `${uploadProgress}%` }} />
          </div>
        )}

        {attachment && (
          <div className="context-bar">
            <span>Attached: {attachment.name} ({formatBytes(attachment.size)})</span>
            <button onClick={() => setAttachment(null)} type="button">Remove</button>
          </div>
        )}

        {status && <p className="status-line">{status}</p>}
      </section>

      <nav className="mobile-nav">
        <button className={mode === "direct" ? "active" : ""} onClick={() => setMode("direct")} type="button">
          Direct
        </button>
        <button className={mode === "group" ? "active" : ""} onClick={() => setMode("group")} type="button">
          Groups
        </button>
        <button onClick={() => setShowSettingsModal(true)} type="button">Settings</button>
      </nav>

      {showSettingsModal && (
        <div className="modal-wrap" onClick={() => setShowSettingsModal(false)}>
          <div className="modal-card settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-head">
              <h4>Settings</h4>
              <button onClick={() => setShowSettingsModal(false)} type="button">Close</button>
            </div>

            <p className="settings-title">Theme</p>
            <div className="chip-row">
              {["light", "dark", "midnight"].map((value) => (
                <button key={value} className={theme === value ? "active" : ""} onClick={() => setTheme(value)} type="button">
                  {value}
                </button>
              ))}
            </div>

            <p className="settings-title">Accent</p>
            <div className="chip-row">
              {["emerald", "blue", "amber"].map((value) => (
                <button key={value} className={accent === value ? "active" : ""} onClick={() => setAccent(value)} type="button">
                  {value}
                </button>
              ))}
            </div>

            <p className="settings-title">Density</p>
            <div className="chip-row">
              {["comfortable", "compact"].map((value) => (
                <button key={value} className={density === value ? "active" : ""} onClick={() => setDensity(value)} type="button">
                  {value}
                </button>
              ))}
            </div>

            <p className="settings-title">Wallpaper</p>
            <div className="chip-row">
              {["paper", "mist", "grid"].map((value) => (
                <button key={value} className={wallpaper === value ? "active" : ""} onClick={() => setWallpaper(value)} type="button">
                  {value}
                </button>
              ))}
            </div>

            <p className="settings-title">Shared Files</p>
            <div className="file-list">
              {sharedFiles.slice(0, 10).map((file, index) => (
                <a key={`${file.name}-${index}`} href={file.dataUrl} download={file.name}>
                  {file.name}
                </a>
              ))}
              {sharedFiles.length === 0 && <small>No files yet</small>}
            </div>
          </div>
        </div>
      )}

      {showGroupModal && (
        <div className="modal-wrap">
          <div className="modal-card">
            <h4>Create Group</h4>
            <input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Group name" />
            <p>Select members</p>
            <div className="member-grid">
              {users.map((user) => (
                <label key={user.id}>
                  <input
                    type="checkbox"
                    checked={groupMembers.includes(user.id)}
                    onChange={() =>
                      setGroupMembers((prev) =>
                        prev.includes(user.id)
                          ? prev.filter((item) => item !== user.id)
                          : [...prev, user.id]
                      )
                    }
                  />
                  {user.name}
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button onClick={() => setShowGroupModal(false)} type="button">Cancel</button>
              <button onClick={submitGroupCreate} type="button">Create</button>
            </div>
          </div>
        </div>
      )}

      {showManageModal && (
        <div className="modal-wrap">
          <div className="modal-card">
            <h4>Manage Group</h4>
            <select value={manageAction} onChange={(event) => setManageAction(event.target.value)}>
              <option value="add">Add Member</option>
              <option value="remove">Remove Member</option>
              <option value="promote">Promote Admin</option>
              <option value="demote">Demote Admin</option>
            </select>
            <select value={manageMemberId} onChange={(event) => setManageMemberId(event.target.value)}>
              <option value="">Select user</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>{user.name}</option>
              ))}
            </select>
            <div className="modal-actions">
              <button onClick={() => setShowManageModal(false)} type="button">Cancel</button>
              <button onClick={submitGroupManage} type="button">Apply</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
