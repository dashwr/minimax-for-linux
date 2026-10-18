#!/usr/bin/env bash
# build.sh [versão] [--package]: baixa o bundle oficial macOS, prepara o runtime linux, aplica os patches
# e gera build/<versão>/app-linux. --package também cria dist/minimax-code-<versão>-linux-x64.tar.gz.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
VER="" PKG=0
for a in "$@"; do case "$a" in --package) PKG=1 ;; -h|--help) sed -n 2,3p "$0"; exit 0 ;; *) VER="$a" ;; esac; done
VER="${VER:-$(node -e 'console.log(Object.keys(require("./fetch/versions.json")).sort().pop())')}"
echo "== MiniMax Code $VER para linux"
MMX_VERSION="$VER" fetch/fetch.sh
runtime/setup-runtime.sh
(cd tools && npm ci --no-audit --no-fund --silent)
node patches/apply.mjs "$VER"
if [ "$PKG" = 1 ]; then
  T="minimax-code-$VER-linux-x64"; rm -rf "dist/$T" && mkdir -p "dist/$T"
  cp -a "build/$VER/app-linux" "dist/$T/app-linux"
  cp -a bin install.sh uninstall.sh README.md LICENSE "dist/$T/"
  tar -C dist -czf "dist/$T.tar.gz" "$T" && rm -rf "dist/$T"
  (cd dist && sha256sum "$T.tar.gz" > "$T.tar.gz.sha256")
  echo "pacote: dist/$T.tar.gz"
fi
echo "pronto: build/$VER/app-linux  (instale com ./install.sh)"
