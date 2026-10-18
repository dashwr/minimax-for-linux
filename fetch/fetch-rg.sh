#!/usr/bin/env bash
# fetch-rg.sh <app-dir>: baixa @vscode/ripgrep-linux-x64 na versão que o @vscode/ripgrep do app fixa (npm, integrity sha512 conferida)
# e extrai em runtime/ripgrep-linux-x64-<ver>/ (package/bin/rg). Idempotente. imprime o diretório do pacote em stdout.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$(cd "$1" && pwd)"
VER="$(node -e 'console.log(require(process.argv[1]).optionalDependencies["@vscode/ripgrep-linux-x64"])' "$APP/node_modules/@vscode/ripgrep/package.json")"
[ -n "$VER" ] && [ "$VER" != undefined ] || { echo "versão do ripgrep não encontrada" >&2; exit 1; }
DEST="$ROOT/runtime/ripgrep-linux-x64-$VER"
if [ -x "$DEST/bin/rg" ]; then echo "$DEST"; exit 0; fi
mkdir -p "$ROOT/runtime/npm-packs"
META="$(curl -fsS --retry 3 "https://registry.npmjs.org/@vscode/ripgrep-linux-x64/$VER")"
URL="$(node -e 'console.log(JSON.parse(process.argv[1]).dist.tarball)' "$META")"
INTEG="$(node -e 'console.log(JSON.parse(process.argv[1]).dist.integrity.replace(/^sha512-/,""))' "$META")"
TGZ="$ROOT/runtime/npm-packs/ripgrep-linux-x64-$VER.tgz"
curl -fsSL --retry 3 -o "$TGZ.part" "$URL" >&2
[ "$(openssl dgst -sha512 -binary "$TGZ.part" | base64 -w0)" = "$INTEG" ] || { rm -f -- "$TGZ.part"; echo "integrity do ripgrep não confere" >&2; exit 1; }
mv -f "$TGZ.part" "$TGZ"
mkdir -p "$DEST.tmp" && tar -xzf "$TGZ" -C "$DEST.tmp" --strip-components=1
chmod +x "$DEST.tmp/bin/rg"
rm -rf -- "$DEST"; mv "$DEST.tmp" "$DEST"
echo "$DEST"
