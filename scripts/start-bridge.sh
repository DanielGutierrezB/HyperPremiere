#!/bin/bash
# Levanta el puente local de HyperPremiere. Instala deps la primera vez.
set -e
DIR="$(cd "$(dirname "$0")/../bridge" && pwd)"
cd "$DIR"
PORT="${HP_PORT:-7867}"
# Matar cualquier puente viejo en el puerto (evita instancias colgadas).
lsof -ti:"$PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
pkill -9 -f "bridge/server.js" 2>/dev/null || true
if [ ! -d node_modules ]; then
  echo "[hyperpremiere] instalando dependencias del puente (una sola vez)…"
  npm install
fi
echo "[hyperpremiere] arrancando puente en http://127.0.0.1:$PORT"
exec node server.js
