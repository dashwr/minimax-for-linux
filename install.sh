#!/usr/bin/env bash
# install.sh: instala o MiniMax Code (port linux) para o usuário. PREFIX=~/.local por padrão.
# usa ./app-linux (tarball de release) ou build/<versão>/app-linux (checkout; rode ./build.sh antes).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local}"
if [ -d "$HERE/app-linux" ]; then SRC="$HERE/app-linux"
else SRC="$(ls -d "$HERE"/build/*/app-linux 2>/dev/null | sort -V | tail -1)"; fi
[ -n "${SRC:-}" ] && [ -x "$SRC/minimax-code" ] || { echo "app-linux não encontrado: rode ./build.sh primeiro" >&2; exit 1; }
if pgrep -f "$PREFIX/lib/minimax-code/minimax-code" >/dev/null; then echo "feche o MiniMax Code antes de instalar" >&2; exit 1; fi
echo "instalando de $SRC em $PREFIX"
mkdir -p "$PREFIX/lib" "$PREFIX/bin" "$PREFIX/share/applications"
rm -rf "$PREFIX/lib/minimax-code.new"
cp -a "$SRC" "$PREFIX/lib/minimax-code.new"
rm -rf "$PREFIX/lib/minimax-code" && mv "$PREFIX/lib/minimax-code.new" "$PREFIX/lib/minimax-code"
install -m755 "$HERE/bin/minimax-code" "$PREFIX/bin/minimax-code"
for d in "$SRC"/share/icons/hicolor/*; do
  s="$(basename "$d")"; mkdir -p "$PREFIX/share/icons/hicolor/$s/apps"
  install -m644 "$d/apps/minimax-code.png" "$PREFIX/share/icons/hicolor/$s/apps/minimax-code.png"
done
sed "s|^Exec=.*|Exec=$PREFIX/bin/minimax-code %U|" "$SRC/share/applications/minimax-code.desktop" > "$PREFIX/share/applications/minimax-code.desktop"
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -f -t "$PREFIX/share/icons/hicolor" 2>/dev/null || true
command -v update-desktop-database >/dev/null && update-desktop-database -q "$PREFIX/share/applications" 2>/dev/null || true
command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true
echo "ok: rode 'minimax-code' ou abra pelo menu. (garanta $PREFIX/bin no PATH)"
