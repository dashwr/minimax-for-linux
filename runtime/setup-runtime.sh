#!/usr/bin/env bash
# setup-runtime.sh: prepara runtime/ a partir de fontes oficiais, sem binários no repositório.
#  - electron <ver> linux-x64 (GitHub releases; sha256 do zip conferido com SHASUMS256.txt e com manifest.json)
#  - node-pty e better-sqlite3 recompilados para a ABI do electron (@electron/rebuild)
#  - pacotes nativos linux do npm (integridade conferida pelo npm) nas versões de manifest.json
# idempotente: pula o que já existe e confere.
set -euo pipefail
RT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { printf '[runtime] %s\n' "$*"; }
die() { printf '[runtime] ERRO: %s\n' "$*" >&2; exit 1; }
for c in node npm curl unzip tar sha256sum python3 make g++; do command -v "$c" >/dev/null || die "comando ausente: $c"; done
m() { node -e 'const m=require(process.argv[1]);console.log(process.argv[2].split(".").reduce((o,k)=>o[k],m))' "$RT/manifest.json" "$1"; }

# 1. electron
EV="$(m electron.version)"; EDIR="$RT/electron-$EV"; ESHA="$(m electron.sha256)"
if [ -x "$EDIR/electron" ] && [ -f "$EDIR/.zip-sha256" ] && [ "$(cat "$EDIR/.zip-sha256")" = "$ESHA" ]; then
  log "electron $EV ok"
else
  Z="electron-v$EV-linux-x64.zip"; B="https://github.com/electron/electron/releases/download/v$EV"
  log "baixando $Z"
  curl -fsSL --retry 3 -o "$RT/SHASUMS256.txt" "$B/SHASUMS256.txt"
  curl -fL --retry 3 -sS -o "$RT/$Z.part" "$B/$Z"
  want="$(awk -v f="*$Z" '$2==f{print $1}' "$RT/SHASUMS256.txt")"
  got="$(sha256sum "$RT/$Z.part" | cut -d' ' -f1)"
  [ -n "$want" ] && [ "$got" = "$want" ] && [ "$got" = "$ESHA" ] || { rm -f -- "$RT/$Z.part"; die "sha256 do $Z não confere (SHASUMS256/manifest.json)"; }
  rm -rf -- "$EDIR.tmp" && mkdir -p "$EDIR.tmp" && unzip -q "$RT/$Z.part" -d "$EDIR.tmp" && rm -f -- "$RT/$Z.part"
  echo "$ESHA" > "$EDIR.tmp/.zip-sha256"
  rm -rf -- "$EDIR" && mv "$EDIR.tmp" "$EDIR"
  log "electron $EV em $EDIR"
fi

# 2. node-pty + better-sqlite3 para a ABI do electron
NB="$RT/native-build"
if [ -f "$NB/node_modules/node-pty/build/Release/pty.node" ] && [ -f "$NB/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ] && [ -f "$NB/.electron-$EV" ]; then
  log "native-build ok"
else
  log "compilando node-pty e better-sqlite3 para electron $EV"
  (cd "$NB" && npm ci --ignore-scripts --no-audit --no-fund && npx --yes @electron/rebuild@4 -v "$EV" -f -w node-pty,better-sqlite3)
  touch "$NB/.electron-$EV"
fi

# 3. pacotes nativos linux do npm (diretório runtime/<nome-sanitizado>-<ver>/ com o conteúdo do pacote)
mkdir -p "$RT/npm-packs"
for pkg in @trycua/cua-driver-linux-x64-gnu @ubjs/node-linux-x64-gnu node-screenshots-linux-x64-gnu @mariozechner/clipboard-linux-x64-gnu; do
  ver="$(node -e 'console.log(require(process.argv[1]).natives[process.argv[2]].version)' "$RT/manifest.json" "$pkg")"
  name="$(echo "$pkg" | sed 's/^@//; s#/#-#')"; dir="$RT/$name-$ver"
  [ -f "$dir/package.json" ] && { log "$pkg@$ver ok"; continue; }
  log "npm pack $pkg@$ver"
  tgz="$(cd "$RT/npm-packs" && npm pack --silent "$pkg@$ver" | tail -1)"
  rm -rf -- "$dir.tmp" && mkdir -p "$dir.tmp" && tar -xzf "$RT/npm-packs/$tgz" -C "$dir.tmp" --strip-components=1
  rm -rf -- "$dir" && mv "$dir.tmp" "$dir"
done

# 4. confere que todo arquivo citado no manifest existe
node -e '
const fs=require("fs"),p=require("path"),rt=process.argv[1],m=require(p.join(rt,"manifest.json"));
const need=[m.electron.path,...Object.values(m.natives).flatMap(n=>[n.node,n.so].filter(Boolean))];
const miss=need.filter(f=>!fs.existsSync(p.join(rt,f)));
if(miss.length){console.error("[runtime] ausentes: "+miss.join(", "));process.exit(1)}' "$RT"
log "runtime pronto"
