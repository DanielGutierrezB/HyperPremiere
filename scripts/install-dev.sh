#!/usr/bin/env bash
set -euo pipefail

# Habilitar modo debug de CEP (CSXS 12 para Premiere 2026, CSXS 11 por compat)
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
defaults write com.adobe.CSXS.11 PlayerDebugMode 1

# Resolver ruta absoluta del repo a partir de la ubicación de este script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CEP_SRC="$REPO_DIR/cep"

EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
LINK_PATH="$EXT_DIR/com.codigo.hyperpremiere"

mkdir -p "$EXT_DIR"

if [ -L "$LINK_PATH" ]; then
  rm "$LINK_PATH"
elif [ -e "$LINK_PATH" ]; then
  echo "Error: $LINK_PATH existe y no es un symlink. Elimínalo manualmente." >&2
  exit 1
fi

ln -s "$CEP_SRC" "$LINK_PATH"

echo "Symlink creado: $LINK_PATH -> $CEP_SRC"
echo "PlayerDebugMode habilitado (CSXS 11 y 12)."
echo "Reinicia Premiere Pro para cargar la extensión."
