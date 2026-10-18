#!/usr/bin/env bash
# uninstall.sh: remove o que o install.sh instalou. não toca no perfil (~/.config/MiniMax Agent, ~/.minimax).
set -euo pipefail
PREFIX="${PREFIX:-$HOME/.local}"
rm -rf "$PREFIX/lib/minimax-code"
rm -f "$PREFIX/bin/minimax-code" "$PREFIX/share/applications/minimax-code.desktop"
rm -f "$PREFIX"/share/icons/hicolor/*/apps/minimax-code.png
command -v update-desktop-database >/dev/null && update-desktop-database -q "$PREFIX/share/applications" 2>/dev/null || true
echo "removido de $PREFIX (perfil preservado)"
