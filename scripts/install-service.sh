#!/bin/bash
# Instala el puente de HyperPremiere como LaunchAgent (auto-arranca y se mantiene vivo).
# Nada de terminales abiertas: se ejecuta en segundo plano al iniciar sesión.
set -e
UID_=$(id -u)
LABEL="ai.hyperpremiere.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BRIDGE="$(cd "$(dirname "$0")/../bridge" && pwd)"
NODE="$(command -v node)"
CLAUDE_DIR="$(dirname "$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")")"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$BRIDGE/server.js</string></array>
  <key>WorkingDirectory</key><string>$BRIDGE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:$CLAUDE_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HP_PORT</key><string>7867</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/hyperpremiere-bridge.log</string>
  <key>StandardErrorPath</key><string>/tmp/hyperpremiere-bridge.log</string>
</dict>
</plist>
PL

launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
echo "[hyperpremiere] servicio instalado. /health:"
sleep 1 2>/dev/null || true
curl -s http://127.0.0.1:7867/health || echo "(dale unos segundos y probá curl http://127.0.0.1:7867/health)"
