// extract-asar.mjs: extrai um app.asar (formato Electron) sem dependencias.
// Uso: node extract-asar.mjs <app.asar> <app.asar.unpacked> <outDir>
// Diferente de `asar extract` (@electron/asar), tolera entradas `unpacked` ausentes
// no zip (ex.: binarios de outras arquiteturas) e as reporta no JSON de stdout.
import fs from "node:fs";
import path from "node:path";

const [asarPath, unpackedDir, outDir] = process.argv.slice(2);
if (!asarPath || !unpackedDir || !outDir) {
  console.error("uso: extract-asar.mjs <app.asar> <app.asar.unpacked> <outDir>");
  process.exit(2);
}

const fd = fs.openSync(asarPath, "r");
const sizeBuf = Buffer.alloc(8);
fs.readSync(fd, sizeBuf, 0, 8, 0);
const headerSize = sizeBuf.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 8);
const jsonLen = headerBuf.readUInt32LE(4);
const root = JSON.parse(headerBuf.subarray(8, 8 + jsonLen).toString("utf8"));
const dataBase = 8 + headerSize;

const out = path.resolve(outDir);
fs.mkdirSync(out, { recursive: true });
const inside = (p) => p === out || p.startsWith(out + path.sep);

const stats = { files: 0, bytes: 0, links: 0, dirs: 0, unpacked_copied: 0, missing_unpacked: [] };

function walk(node, rel) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const relPath = path.join(rel, name);
    const dst = path.join(out, relPath);
    if (!inside(dst)) throw new Error("caminho fora do destino: " + relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });

    if (entry.files) {
      fs.mkdirSync(dst, { recursive: true });
      stats.dirs++;
      walk(entry, relPath);
    } else if (entry.link !== undefined) {
      const target = path.join(out, entry.link);
      if (!inside(target)) throw new Error("link fora do pacote: " + relPath);
      fs.rmSync(dst, { force: true });
      fs.symlinkSync(path.relative(path.dirname(dst), target), dst);
      stats.links++;
    } else if (entry.unpacked) {
      const src = path.join(unpackedDir, relPath);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        if (entry.executable) fs.chmodSync(dst, 0o755);
        stats.unpacked_copied++;
      } else {
        stats.missing_unpacked.push(relPath);
      }
    } else {
      const buf = Buffer.alloc(Number(entry.size));
      fs.readSync(fd, buf, 0, buf.length, dataBase + Number(entry.offset));
      fs.writeFileSync(dst, buf, { mode: entry.executable ? 0o755 : 0o644 });
      stats.files++;
      stats.bytes += buf.length;
    }
  }
}

walk(root, "");
fs.closeSync(fd);
console.log(JSON.stringify(stats));
