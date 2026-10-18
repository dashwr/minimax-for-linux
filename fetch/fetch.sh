#!/usr/bin/env bash
# fetch.sh: baixa o bundle macOS x64 oficial (feed latest-mac.yml), confere sha512
# e extrai app.asar + recursos para build/<ver>/{app,resources,meta.json}.
# Idempotente: nao baixa o zip se o cache confere; nao reextrai se meta.json bate.
set -euo pipefail

FEED_URL="${MMX_FEED_URL:-https://file.cdn.minimax.io/public/minimax-agent-prod/release/latest-mac.yml}"
REUSE_ZIP="${MMX_REUSE_ZIP:-}"  # zip mac x64 já baixado (opcional; sha512 conferido)
PIN="${MMX_VERSION:-}"            # versão fixa (ex. 3.1.3); vazio = latest do feed

FETCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${MMX_BUILD_DIR:-$(dirname "$FETCH_DIR")/build}" # MMX_BUILD_DIR: só para teste de download em dir descartável
CACHE_DIR="$BUILD_DIR/cache"
YML="$CACHE_DIR/latest-mac.yml"

log() { printf '[fetch] %s\n' "$*"; }
die() { printf '[fetch] ERRO: %s\n' "$*" >&2; exit 1; }
sha512_b64() { openssl dgst -sha512 -binary "$1" | base64 -w0; }

mkdir -p "$CACHE_DIR"

# 1. feed (sempre consultado: e ele que define a versao "latest")
if curl -fsSL --retry 3 -o "$YML.part" "$FEED_URL"; then
  mv -f "$YML.part" "$YML"
elif [ -f "$YML" ]; then
  log "aviso: feed inacessivel, usando $YML em cache (pode estar desatualizado)"
else
  die "nao consegui baixar o feed $FEED_URL"
fi

VERSION="$(awk '/^version:/{print $2}' "$YML" | tr -d "'\"" | sed -n 1p)"
RELEASE_DATE="$(awk '/^releaseDate:/{sub(/^releaseDate: */,""); print}' "$YML" | tr -d "'\"" | sed -n 1p)"
[ -n "$VERSION" ] || die "versao ausente no feed"

# 2. escolhe o zip x64 (nome *-mac.zip sem arm64) e seu sha512 em base64
ENTRY="$(awk '
  /^  - url: /      { u = $0; sub(/^  - url: /, "", u); next }
  /^    sha512: /   { s = $0; sub(/^    sha512: /, "", s)
                     if (u ~ /-mac\.zip$/ && u !~ /arm64/ && x64u == "") { x64u = u; x64s = s } }
  END { if (x64u != "") print x64u "\t" x64s }
' "$YML" | tr -d "'\"")"
[ -n "$ENTRY" ] || die "nenhum zip mac x64 no feed"
ZIP_NAME="${ENTRY%%$'\t'*}"
EXPECTED_SHA="${ENTRY#*$'\t'}"

# versão fixada: usa nome/sha512 de fetch/versions.json em vez do latest do feed
if [ -n "$PIN" ] && [ "$PIN" != "$VERSION" ]; then
  PINNED="$(node -e 'const v=require(process.argv[1])[process.argv[2]];if(!v)process.exit(1);console.log(v.zip_name+"\t"+v.sha512+"\t"+(v.release_date||""))' "$FETCH_DIR/versions.json" "$PIN")" \
    || die "versão $PIN ausente em fetch/versions.json"
  ZIP_NAME="${PINNED%%$'\t'*}"; REST="${PINNED#*$'\t'}"; EXPECTED_SHA="${REST%%$'\t'*}"; RELEASE_DATE="${REST#*$'\t'}"
  log "feed está em $VERSION; usando versão fixada $PIN"
  VERSION="$PIN"
fi

# url relativa ao diretorio do yml (espacos -> %20)
ZIP_URL="${FEED_URL%/*}/${ZIP_NAME// /%20}"
CACHE_ZIP="$CACHE_DIR/mac-x64-$VERSION.zip"
log "versao $VERSION (releaseDate $RELEASE_DATE) zip=$ZIP_NAME"

# 3. zip em cache, com sha512 conferido
zip_ok() { [ -f "$1" ] && [ "$(sha512_b64 "$1")" = "$EXPECTED_SHA" ]; }

if zip_ok "$CACHE_ZIP"; then
  log "zip em cache confere (sha512 ok); sem download"
else
  if [ -n "$REUSE_ZIP" ] && [ -f "$REUSE_ZIP" ] && [ "$(sha512_b64 "$REUSE_ZIP")" = "$EXPECTED_SHA" ]; then
    log "reaproveitando $REUSE_ZIP (sha512 confere)"
    cp -f "$REUSE_ZIP" "$CACHE_ZIP.part"
  else
    log "baixando $ZIP_URL"
    curl -fL --retry 3 -C - -sS -o "$CACHE_ZIP.part" "$ZIP_URL"
  fi
  if [ "$(sha512_b64 "$CACHE_ZIP.part")" != "$EXPECTED_SHA" ]; then
    rm -f -- "$CACHE_ZIP.part"
    die "sha512 nao confere para $ZIP_NAME (download descartado)"
  fi
  mv -f "$CACHE_ZIP.part" "$CACHE_ZIP"
  log "zip verificado: $CACHE_ZIP"
fi

# 4. extracao (pulada se meta.json ja corresponde a este sha512)
DEST="$BUILD_DIR/$VERSION"
if [ -f "$DEST/meta.json" ] && [ -d "$DEST/app" ] && [ -d "$DEST/resources" ] \
   && grep -qF "\"sha512\": \"$EXPECTED_SHA\"" "$DEST/meta.json"; then
  log "build/$VERSION ja extraido e meta.json confere; nada a fazer"
  log "destino: $DEST"
  exit 0
fi

TMP="$DEST.tmp-$$"
trap '[ -d "$TMP" ] && rm -rf -- "$TMP"' EXIT
rm -rf -- "$TMP"
mkdir -p "$TMP/raw" "$TMP/resources"

APP_BUNDLE="$(unzip -Z1 "$CACHE_ZIP" | awk -F/ '$1 ~ /\.app$/ && $2 == "Contents" && $3 == "Resources" && $4 == "app.asar" { print $1 }' | sed -n 1p)"
[ -n "$APP_BUNDLE" ] || die "app.asar nao encontrado dentro do zip"
log "bundle: $APP_BUNDLE"

# unzip retorna 1 para avisos (ex.: entradas duplicadas); so 2+ e erro
unzip -q "$CACHE_ZIP" \
  "$APP_BUNDLE/Contents/Resources/*" \
  "$APP_BUNDLE/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist" \
  -d "$TMP/raw" || [ $? -eq 1 ]

RAW="$TMP/raw/$APP_BUNDLE/Contents"
RES="$RAW/Resources"
[ -f "$RES/app.asar" ] || die "app.asar ausente apos unzip"

# app.asar -> app/ (extrator local sem dependencias; `asar extract` aborta quando
# o header lista binarios unpacked de outras arquiteturas ausentes no zip)
ASAR_STATS="$(node "$FETCH_DIR/extract-asar.mjs" "$RES/app.asar" "$RES/app.asar.unpacked" "$TMP/app")"

# demais Contents/Resources (mcode-tools, app.asar.unpacked, lproj, icones)
cp -a "$RES/." "$TMP/resources/"
rm -f -- "$TMP/resources/app.asar"

EPLIST="$RAW/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist"

# meta.json
node -e '
const fs = require("fs");
const [ver, relDate, zipName, zipUrl, sha, zipPath, appBundle, tmp, eplist, asarStats] = process.argv.slice(1);
const plist = (p, k) => {
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, "utf8").match(new RegExp("<key>" + k + "</key>\\s*<string>([^<]*)</string>"));
  return m ? m[1] : null;
};
const pkg = JSON.parse(fs.readFileSync(tmp + "/app/package.json", "utf8"));
const meta = {
  version: ver,
  release_date: relDate,
  zip_name: zipName,
  zip_url: zipUrl,
  sha512: sha,
  size_bytes: fs.statSync(zipPath).size,
  app_bundle: appBundle,
  app_package_name: pkg.name || null,
  app_package_version: pkg.version || null,
  electron_version: plist(eplist, "CFBundleShortVersionString") || plist(eplist, "CFBundleVersion"),
  electron_bundle_version: plist(eplist, "CFBundleVersion"),
  asar_source: appBundle + "/Contents/Resources/app.asar",
  extracted_with: "fetch/extract-asar.mjs",
  asar_extract: JSON.parse(asarStats),
  fetched_at: new Date().toISOString(),
  script: "fetch/fetch.sh",
};
fs.writeFileSync(tmp + "/meta.json", JSON.stringify(meta, null, 2) + "\n");
' "$VERSION" "$RELEASE_DATE" "$ZIP_NAME" "$ZIP_URL" "$EXPECTED_SHA" "$CACHE_ZIP" "$APP_BUNDLE" "$TMP" "$EPLIST" "$ASAR_STATS"

rm -rf -- "$TMP/raw"

rm -rf -- "$DEST"
mv -- "$TMP" "$DEST"
log "extraido em $DEST (app/, resources/, meta.json)"
