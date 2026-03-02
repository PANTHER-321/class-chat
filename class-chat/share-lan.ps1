$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $projectRoot "server"
$clientDir = Join-Path $projectRoot "client"

$preferredConfig = Get-NetIPConfiguration |
  Where-Object {
    $_.IPv4DefaultGateway -ne $null -and
    $_.IPv4Address -ne $null
  } |
  Select-Object -First 1

$ip = $null
if ($preferredConfig) {
  $ip = $preferredConfig.IPv4Address[0].IPAddress
}

if (-not $ip) {
  $ip = (
    Get-NetIPAddress -AddressFamily IPv4 |
      Where-Object {
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*" -and
        $_.PrefixOrigin -ne "WellKnown"
      } |
      Select-Object -First 1 -ExpandProperty IPAddress
  )
}

if (-not $ip) {
  throw "Could not detect LAN IPv4 address."
}

$serverCmd = "`$env:CLIENT_ORIGIN='*'; npm run dev"
$clientCmd = "`$env:VITE_API_BASE_URL='http://$ip`:5000'; npm run dev -- --host 0.0.0.0 --port 5173"

Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoExit", "-Command", $serverCmd) -WorkingDirectory $serverDir
Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoExit", "-Command", $clientCmd) -WorkingDirectory $clientDir

Write-Host ""
Write-Host "Share this link with classmates on same network:"
Write-Host "http://$ip`:5173" -ForegroundColor Green
Write-Host "API URL used by client:"
Write-Host "http://$ip`:5000" -ForegroundColor Cyan
Write-Host ""
Write-Host "Keep this PC, server window, and client window running."
