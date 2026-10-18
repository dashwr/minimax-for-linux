#!/usr/bin/env node
// opt3: empacota os grafos ESM do utility local-runtime (@mavis/local-runtime-v2, @mavis/local-runtime/common, v2/wechat-sdk) com esbuild.
// uso: node patches/bundle/runtime-bundle.mjs <app-dir> <outdir>   (esbuild fixado em tools/)
// regras de preservação de comportamento:
//  - externals (nativos, workers/__dirname, jiti etc.) viram import de caminho RELATIVO ao arquivo exato que o node resolveria (mesma versão aninhada).
//  - em cada arquivo empacotado, import.meta.url/dirname/filename/resolve apontam para o arquivo ORIGINAL (assets, createRequire, workers continuam achando o disco).
//  - import(<não-literal>) relativo resolve contra o arquivo original.
//  - require() dinâmico em CJS empacotado: banner com createRequire(chunk).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))); // raiz do repo
const esbuild = createRequire(path.join(ROOT, 'tools/package.json'))('esbuild');
const [APP, OUTDIR] = process.argv.slice(2).map((p) => path.resolve(p));
if (!APP || !OUTDIR) { console.error('uso: runtime-bundle.mjs <app-dir> <outdir>'); process.exit(2); }
const UTIL = path.join(APP, 'dist/main/modules/local-runtime/utility');
const NM = path.join(APP, 'node_modules');

// pacotes mantidos fora do bundle (nome exato ou prefixo com /*)
const EXTERNAL_PKGS = [
  'electron', 'better-sqlite3', 'node-pty', 'bindings', 'node-gyp-build', // nativos / loaders de .node
  '@mariozechner/clipboard*', '@trycua/*', 'node-screenshots*', '@vscode/ripgrep*', '@ubjs/*', '@silvia-odwyer/photon-node',
  'jiti', // carrega extensões em runtime com babel próprio e __dirname
  'thread-stream', 'pino', 'pino-pretty', 'pino-abstract-transport', 'sonic-boom', 'real-require', // transports em worker_threads achados por __dirname
  'undici', // __dirname e workers internos; CJS grande
];
const pkgOf = (spec) => { const p = spec.split('/'); return spec.startsWith('@') ? p.slice(0, 2).join('/') : p[0]; };
const isExtPkg = (spec) => { const n = pkgOf(spec); return EXTERNAL_PKGS.some((e) => (e.endsWith('*') ? n.startsWith(e.slice(0, -1)) : n === e)); };
const rel = (abs) => { let r = path.relative(OUTDIR, abs).split(path.sep).join('/'); return r.startsWith('.') ? r : './' + r; };

const externalsUsed = new Set();
const plugin = {
  name: 'mmx-runtime',
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (a) => { externalsUsed.add(a.path); return { path: a.path, external: true }; });
    build.onResolve({ filter: /^[^./]/ }, async (a) => {
      if (a.pluginData?.mmx || a.path.startsWith('node:') || !isExtPkg(a.path)) return;
      const r = await build.resolve(a.path, { kind: a.kind, resolveDir: a.resolveDir, importer: a.importer, pluginData: { mmx: 1 } });
      if (r.errors.length || !r.path || r.external) { externalsUsed.add(a.path + ' (bare)'); return { path: a.path, external: true }; }
      externalsUsed.add(pkgOf(a.path));
      return { path: rel(r.path), external: true };
    });
    build.onLoad({ filter: /\.(c|m)?js$/ }, async (a) => {
      let src = await fs.promises.readFile(a.path, 'utf8');
      const orig = src;
      if (src.includes('import.meta')) {
        const U = `new URL(${JSON.stringify(rel(a.path))}, import.meta.url)`;
        src = src
          .replace(/\bimport\.meta\.url\b/g, `${U}.href`)
          .replace(/\bimport\.meta\.filename\b/g, `decodeURIComponent(${U}.pathname)`)
          .replace(/\bimport\.meta\.dirname\b/g, `decodeURIComponent(new URL(".", ${U}).pathname).replace(/\\/$/, "")`)
          .replace(/\bimport\.meta\.resolve\(/g, `__mmx_meta_resolve(${U}.href, `);
      }
      // import(<expr>) não literal: relativo -> contra o arquivo original. exclui métodos (obj.import(, async import(, import(x) {)
      if (/(?<![\w$.]|async\s)\bimport\(\s*[^\s'"`)]/.test(src)) {
        const U = `new URL(${JSON.stringify(rel(a.path))}, import.meta.url).href`;
        src = src.replace(/(?<![\w$.]|async\s)\bimport\((?=\s*[^\s'"`)])/g, `__mmx_dyn_import(${U}, `);
      }
      return src === orig ? undefined : { contents: src, loader: 'js', resolveDir: path.dirname(a.path) };
    });
  },
};

const banner = [
  "import { createRequire as __mmx_cr } from 'node:module';",
  'const require = __mmx_cr(import.meta.url);',
  'const __mmx_dyn_import = (base, s, o) => import(typeof s === "string" && /^\\.\\.?\\//.test(s) ? new URL(s, base).href : s, o);',
  'const __mmx_meta_resolve = (base, s) => (/^\\.\\.?\\//.test(s) ? new URL(s, base).href : import.meta.resolve(s, base));',
].join('\n');

fs.rmSync(OUTDIR, { recursive: true, force: true });
const t0 = Date.now();
const r = await esbuild.build({
  absWorkingDir: UTIL,
  entryPoints: { v2: '@mavis/local-runtime-v2', common: '@mavis/local-runtime/common', wechat: '@mavis/local-runtime-v2/wechat-sdk' },
  bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node22', // electron 42 = node 24
  outdir: OUTDIR, outExtension: { '.js': '.mjs' }, chunkNames: 'chunk-[name]-[hash]', metafile: true,
  banner: { js: banner }, plugins: [plugin], logLevel: 'error', legalComments: 'none', keepNames: true, minifyWhitespace: process.env.MMX_BUNDLE_MINIFY === '1', minifySyntax: process.env.MMX_BUNDLE_MINIFY === '1',
});
// sanidade: nenhum import relativo de chunk pode escapar para fora do outdir exceto externals deliberados
fs.writeFileSync(path.join(OUTDIR, 'meta.json'), JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, esbuild: esbuild.version,
  inputs: Object.keys(r.metafile.inputs).length, externals: [...externalsUsed].sort() }, null, 1) + '\n');
console.log(`runtime-bundle: ${Object.keys(r.metafile.inputs).length} módulos -> ${Object.keys(r.metafile.outputs).length} arquivos em ${Date.now() - t0} ms; externals: ${[...externalsUsed].sort().join(' ')}`);
