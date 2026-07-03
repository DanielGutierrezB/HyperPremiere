#!/bin/bash
# Levanta el puente local de HyperPremiere. La primera vez instala dependencias
# (incluye hyperframes; baja Chromium arm64). Requiere Node arm64 y ffmpeg.
set -e
DIR="$(cd "$(dirname "$0")/../bridge" && pwd)"
cd "$DIR"
if [ ! -d node_modules ]; then
  echo "[hyperpremiere] instalando dependencias del puente (una sola vez)…"
  npm install
fi
echo "[hyperpremiere] arrancando puente en http://127.0.0.1:7867"
exec node server.js
