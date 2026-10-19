#!/usr/bin/env node
// gera build/<ver>/app-linux (layout electron empacotado) a partir de build/<ver>/app (pristino) e aplica patches em camadas.
// uso: node patches/apply.mjs <ver>. idempotente e atômico: gera em app-linux.tmp e só troca app-linux se tudo obrigatório passou;
// em falha remove o .tmp e mantém o app-linux anterior. (teste: MMX_TEST_BREAK=<id do patch> corrompe a âncora desse patch)
// layout: app-linux/minimax-code (electron 42.8.0 hardlinkado de runtime/), app-linux/resources/app (app patcheado),
// app-linux/resources/resources (recursos do bundle). assim app.isPackaged=true e process.resourcesPath=app-linux/resources.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // raiz do repo
const ver = process.argv[2];
if (!ver) { console.error('uso: node patches/apply.mjs <ver>'); process.exit(2); }
const BUILD = path.join(ROOT, 'build', ver);
const SRC_APP = path.join(BUILD, 'app');
const SRC_RES = path.join(BUILD, 'resources');
const FINAL = path.join(BUILD, 'app-linux');
const OUT = FINAL + '.tmp';
let committed = false;
process.on('exit', () => { if (!committed) fs.rmSync(OUT, { recursive: true, force: true }); });
const RUNTIME = path.join(ROOT, 'runtime');
const manifest = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'manifest.json'), 'utf8'));
const APP = path.join(OUT, 'resources', 'app');
const NM = path.join(APP, 'node_modules');

const applied = [];
const warnings = [];
const fail = (msg) => { console.error(`ERRO: ${msg}`); process.exit(1); };
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
for (const p of [SRC_APP, SRC_RES, path.join(SRC_APP, 'dist/main/index.js')]) if (!fs.existsSync(p)) fail(`entrada ausente: ${p}`);

// ---- base: layout ----
fs.rmSync(OUT, { recursive: true, force: true }); // só o .tmp
const electronDir = path.dirname(path.join(RUNTIME, manifest.electron.path));
sh('cp', ['-al', electronDir, OUT]); // hardlinks: sem custo de disco; nada aqui é editado
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });
fs.linkSync(path.join(OUT, 'electron'), path.join(OUT, 'minimax-code'));
fs.unlinkSync(path.join(OUT, 'electron')); // nome != electron => app.isPackaged=true
sh('cp', ['-a', '--reflink=auto', SRC_APP, APP]);
// recursos: só resources/resources (lproj/icns/app-update.yml do mac não servem; sem app-update.yml o electron-updater não age)
sh('cp', ['-a', '--reflink=auto', path.join(SRC_RES, 'resources'), path.join(OUT, 'resources', 'resources')]);
applied.push('base:layout-empacotado', 'res:resources-dir (mcode-tools, pptx-core, tray, ssh-mcode-release.json)');

// ---- camada 1: binários nativos ----
const rt = (rel) => { const p = path.join(RUNTIME, rel); if (!fs.existsSync(p)) fail(`runtime ausente: ${p}`); return p; };
const nat = manifest.natives;
const put = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); };
const ensure = (p, id) => { if (!fs.existsSync(p)) fail(`${id}: alvo ausente ${p}`); };

ensure(path.join(NM, 'node-pty/package.json'), 'native:node-pty');
put(rt(nat['node-pty'].node), path.join(NM, 'node-pty/build/Release/pty.node')); // utils.js tenta build/Release antes de prebuilds
applied.push('native:node-pty build/Release/pty.node');

ensure(path.join(NM, 'better-sqlite3/build/Release/better_sqlite3.node'), 'native:better-sqlite3');
put(rt(nat['better-sqlite3'].node), path.join(NM, 'better-sqlite3/build/Release/better_sqlite3.node'));
applied.push('native:better-sqlite3');

const platPkg = (id, name, srcDir, darwinGlob) => {
  if (!fs.readdirSync(path.dirname(path.join(NM, name))).some((d) => d.startsWith(darwinGlob))) fail(`${id}: pacote darwin ${darwinGlob}* não encontrado`);
  sh('cp', ['-a', srcDir, path.join(NM, name)]);
  applied.push(`native:${name}`);
};
platPkg('native:cua', '@trycua/cua-driver-linux-x64-gnu', path.dirname(rt(nat['@trycua/cua-driver-linux-x64-gnu'].node)), 'cua-driver-darwin-');
platPkg('native:ubjs', '@ubjs/node-linux-x64-gnu', path.dirname(rt(nat['@ubjs/node-linux-x64-gnu'].node)), 'node-darwin-');
platPkg('native:clipboard', '@mariozechner/clipboard-linux-x64-gnu', path.dirname(rt(nat['@mariozechner/clipboard-linux-x64-gnu'].node)), 'clipboard-darwin-'); // usado só pelo pi-coding-agent (clipboard-native.js); versão deve casar com @mariozechner/clipboard
{
  const want = nat['@mariozechner/clipboard-linux-x64-gnu'].version, have = JSON.parse(fs.readFileSync(path.join(NM, '@mariozechner/clipboard/package.json'), 'utf8')).version;
  if (want !== have) fail(`native:clipboard: runtime tem ${want}, app usa @mariozechner/clipboard ${have}`);
}
platPkg('native:screenshots', 'node-screenshots-linux-x64-gnu', path.dirname(rt(nat['node-screenshots-linux-x64-gnu'].node)), 'node-screenshots-darwin-');

// ripgrep: @vscode/ripgrep resolve @vscode/ripgrep-<plat>-<arch>/bin/rg; usa o pacote npm linux fixado pelo app (fetch/fetch-rg.sh); rg do sistema só como aviso
{
  const d = path.join(NM, '@vscode/ripgrep-linux-x64');
  try {
    const pkgDir = execFileSync(path.join(ROOT, 'fetch/fetch-rg.sh'), [APP], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim().split('\n').pop();
    fs.mkdirSync(d, { recursive: true });
    sh('cp', ['-a', pkgDir + '/.', d]);
    applied.push(`native:@vscode/ripgrep-linux-x64 (npm ${path.basename(pkgDir)})`);
  } catch (e) {
    try {
      const rg = execFileSync('sh', ['-c', 'command -v rg'], { encoding: 'utf8' }).trim();
      if (!rg) throw new Error('rg não está no PATH');
      put(fs.realpathSync(rg), path.join(d, 'bin/rg'));
      fs.chmodSync(path.join(d, 'bin/rg'), 0o755);
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: '@vscode/ripgrep-linux-x64', version: '0.0.0-system', os: ['linux'], cpu: ['x64'] }) + '\n');
      warnings.push(`native:ripgrep: pacote npm indisponível (${e.message.split('\n')[0]}); usando rg do sistema ${rg}`);
    } catch (e2) { warnings.push(`native:ripgrep: ${e2.message}`); }
  }
}

// remove binários darwin/win32 para não serem carregados por engano
for (const rel of ['node-pty/prebuilds', '@trycua/cua-driver-darwin-x64', '@trycua/cua-driver-darwin-arm64', '@ubjs/node-darwin-x64', '@ubjs/node-darwin-arm64',
  'node-screenshots-darwin-x64', 'node-screenshots-darwin-arm64', '@vscode/ripgrep-darwin-x64', '@vscode/ripgrep-darwin-arm64']) {
  fs.rmSync(path.join(NM, rel), { recursive: true, force: true });
}
// Mach-O/PE restantes (nada no linux os carrega: pi-tui só em darwin, session-transfer procura linux-x64, registry.node é só win32)
for (const rel of ['@earendil-works/pi-tui/native/darwin', '@mariozechner/clipboard-darwin-universal', '@mariozechner/clipboard-darwin-arm64', '@mariozechner/clipboard-darwin-x64']) {
  fs.rmSync(path.join(NM, rel), { recursive: true, force: true });
}
for (const d of fs.readdirSync(NM)) { // prebuilds/<plat> não-linux em qualquer pacote (bare-*, etc.)
  const dirs = d.startsWith('@') ? fs.readdirSync(path.join(NM, d)).map((x) => path.join(d, x)) : [d];
  for (const pkg of dirs) {
    const pb = path.join(NM, pkg, 'prebuilds');
    if (fs.existsSync(pb) && fs.statSync(pb).isDirectory()) for (const plat of fs.readdirSync(pb)) if (/^(darwin|ios|win32|android)/.test(plat)) fs.rmSync(path.join(pb, plat), { recursive: true, force: true });
  }
}
fs.rmSync(path.join(OUT, 'resources/resources/session-transfer/darwin-x64'), { recursive: true, force: true });
// mcode-tools/native/win32-* fica: o host valida por sha256 que todo recurso declarado no manifest existe (sem eles, lifecycle mcode-tools falha)
applied.push('native:poda darwin/win32/ios/android (prebuilds, pi-tui darwin, clipboard-darwin, session-transfer darwin)');

// ---- patches de código ----
// cada patch: {id, file, find: string|RegExp, replace, count (padrão 1), optional}
const patch = ({ id, file, find, replace, count = 1, optional = false }) => {
  if (process.env.MMX_TEST_BREAK === id) find = '<<âncora-inexistente-de-teste>>';
  const abs = path.join(APP, file);
  const err = (m) => { if (optional) { warnings.push(`${id}: ${m}`); return; } fail(`${id} (${file}): ${m}`); };
  if (!fs.existsSync(abs)) return err('arquivo ausente');
  const src = fs.readFileSync(abs, 'utf8');
  const re = typeof find === 'string' ? new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : new RegExp(find.source, find.flags.includes('g') ? find.flags : find.flags + 'g');
  const n = (src.match(re) || []).length;
  if (n !== count) return err(`âncora encontrada ${n}x, esperado ${count}x`);
  const out = src.replace(re, typeof replace === 'function' ? replace : () => replace);
  if (out === src) return err('substituição sem efeito');
  fs.writeFileSync(abs, out);
  applied.push(`${id} (${file}, ${n}x)`);
};

// camada 3: sem auto-update nem hot update
patch({ id: 'upd:initUpdater', file: 'dist/main/modules/updater/index.js',
  find: 'function initUpdater() {\n    if (env_1.isDev) {',
  replace: 'function initUpdater() {\n    if (true /* mmx-linux: auto-update off */ || env_1.isDev) {' });
patch({ id: 'hot:autoCheck', file: 'dist/main/modules/hotUpdate/index.js',
  find: 'const startHotUpdateAutoCheck = () => {\n',
  replace: 'const startHotUpdateAutoCheck = () => {\n    return; /* mmx-linux: hot update off */\n' });
patch({ id: 'hot:bootBundled', file: 'dist/main/modules/hotUpdate/boot.js',
  find: "        root: input.bundledRoot,\n    };\n",
  replace: "        root: input.bundledRoot,\n    };\n    return bundled; /* mmx-linux: sempre renderer embarcado */\n" });

// updater manual / hot update IPC: no linux responde "sem update" no formato do renderer (sem lançar)
patch({ id: 'hot:ipc-check', file: 'dist/main/ipc/hotUpdate.ipc.js',
  find: "async (_event, force) => {\n        try {\n            logger.info(`[HotUpdate IPC] Check for update",
  replace: "async (_event, force) => {\n        if (process.platform === 'linux')\n            return { success: true, hasUpdate: false, currentVersion: hotUpdate_1.hotUpdateManager.getCurrentVersion() }; /* mmx-linux */\n        try {\n            logger.info(`[HotUpdate IPC] Check for update" });
patch({ id: 'upd:ipc-check', file: 'dist/main/ipc/updater.ipc.js',
  find: "        if (env_1.isDev) {\n            return { success: true, status: 'not-available' };",
  replace: "        if (env_1.isDev || process.platform === 'linux') { /* mmx-linux */\n            return { success: true, status: 'not-available' };" });
patch({ id: 'upd:ipc-download-install', file: 'dist/main/ipc/updater.ipc.js', count: 2,
  find: "        if (env_1.isDev)\n            return { success: false, error: 'dev mode' };",
  replace: "        if (env_1.isDev || process.platform === 'linux') /* mmx-linux */\n            return { success: false, error: 'dev mode' };" });

// camada 4: plataforma
patch({ id: 'plat:rcb-getPlatform', file: 'dist/main/modules/remote-control-bridge/ipc.js',
  find: "getPlatform: () => (process.platform === 'win32' ? 'win32' : 'darwin'),",
  replace: "getPlatform: () => (process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin'),",
  /* mmx-linux */ });
const CU = 'dist/main/modules/local-runtime/computer-use/';
// janelas electron (overlay/ponteiro) são portáveis; preview e launch-observation dependem de APIs mac (CG/AX) e ficam como estão
patch({ id: 'cu:overlay', file: CU + 'cua-overlay.js', find: "if (!['win32', 'darwin'].includes(process.platform))", replace: "if (!['win32', 'darwin', 'linux'].includes(process.platform))" });
patch({ id: 'cu:pointer', file: CU + 'cua-pointer.js', find: "if (!['darwin', 'win32'].includes(process.platform))", replace: "if (!['darwin', 'win32', 'linux'].includes(process.platform))" });
patch({ id: 'cu:pointer-target', file: CU + 'cua-pointer-target.js', find: "if (!['darwin', 'win32'].includes(process.platform))", replace: "if (!['darwin', 'win32', 'linux'].includes(process.platform))" });
patch({ id: 'cu:finishOperation', file: CU + 'cua-utility-server.js', find: "const finishOperation = ['win32', 'darwin'].includes(process.platform) &&", replace: "const finishOperation = ['win32', 'darwin', 'linux'].includes(process.platform) &&" });
// gpu-guard.js: só atua via sentinel de crash (isWindows p/ detalhes); no linux mantém comportamento padrão. verificação:
patch({ id: 'gpu:guard-check', file: 'dist/main/modules/gpu-guard.js', find: "function isWindows() {\n    return process.platform === 'win32';\n}",
  replace: "function isWindows() {\n    return process.platform === 'win32'; /* mmx-linux: verificado, sem mudança */\n}" });

// camada obrigatória: backend wayland do cua-driver (sem isso o screenshot falha com X11 BadMatch; w5a)
patch({ id: 'cu:env-wayland', file: CU + 'index.js',
  find: "MAVIS_CUA_DIAGNOSTICS: config_1.isDev ? '1' : '0',",
  replace: "MAVIS_CUA_DIAGNOSTICS: config_1.isDev ? '1' : '0',\n                ...(process.platform === 'linux' && process.env.WAYLAND_DISPLAY && !process.env.CUA_DRIVER_RS_ENABLE_WAYLAND ? { CUA_DRIVER_RS_ENABLE_WAYLAND: '1' } : {}),",
  /* mmx-linux */ });
// camada opcional: preview (só metadados no linux; getScreenPermissionStatus retorna 'not-required' => sem desktopCapturer/portal)
patch({ id: 'cu:preview-publish', file: CU + 'cua-preview.js', find: "    if (process.platform !== 'darwin')\n        return;\n    const previous", replace: "    if (!['darwin', 'linux'].includes(process.platform))\n        return;\n    const previous", optional: true });
patch({ id: 'cu:preview-inspect', file: CU + 'cua-preview.js', find: "if (!target || process.platform !== 'darwin')", replace: "if (!target || !['darwin', 'linux'].includes(process.platform))", optional: true });
patch({ id: 'cu:preview-gate', file: CU + 'cua-utility-server.js', find: "input.onPreviewTarget && process.platform === 'darwin'", replace: "input.onPreviewTarget && ['darwin', 'linux'].includes(process.platform)", optional: true });

// camada opcional: fallback foreground KDE wayland (cu3). arquivos novos de patches/linux-files + gancho no ponto de chamada do driver
{
  const LF = path.join(ROOT, 'patches/linux-files');
  const cuFile = path.join(LF, 'app', CU, 'cua-linux-foreground.js');
  const helper = path.join(LF, 'resources/linux-input/uinput.py');
  if (!fs.existsSync(cuFile) || !fs.existsSync(helper)) fail('cu:kwin-fallback: arquivos ausentes em patches/linux-files');
  put(cuFile, path.join(APP, CU, 'cua-linux-foreground.js'));
  put(helper, path.join(OUT, 'resources/resources/linux-input/uinput.py'));
  applied.push('files:cua-linux-foreground.js + resources/linux-input/uinput.py');
  patch({ id: 'cu:kwin-fallback', file: CU + 'cua-utility-server.js', optional: true,
    find: "    return runtime.callTool(name, payload, signal);\n}\n/** macOS 14.6 crash dumps",
    replace: "    return require('./cua-linux-foreground').withLinuxForegroundFallback(runtime, name, payload, signal, () => runtime.callTool(name, payload, signal)); /* mmx-linux */\n}\n/** macOS 14.6 crash dumps" });
  if (warnings.some((w) => w.startsWith('cu:kwin-fallback'))) console.error('AVISO: âncora cu:kwin-fallback sumiu; fallback foreground KDE wayland NÃO ativo');
}

// camada 5: app empacotado como diretório (sem app.asar) não deve cair no caminho dev de better-sqlite3 (prebuild-install)
patch({ id: 'boot:native-sqlite-packaged', file: 'dist/main/modules/local-runtime/native-sqlite-env.js',
  find: "    return !electronApp.getAppPath().includes('app.asar');",
  replace: "    return false; /* mmx-linux: app empacotado em diretório; better-sqlite3 linux já embarcado */" });

// linux: SNI não emite 'right-click'; menu precisa de setContextMenu (upstream passa null por causa do macOS)
patch({ id: 'ux:tray-menu-linux', file: 'dist/main/modules/tray/index.js', optional: true,
  find: "    t.setContextMenu(null);\n",
  replace: "    t.setContextMenu(process.platform === 'linux' ? createContextMenu() : null); /* mmx-linux */\n" });

// camada opcional: ux (da referência 3.1.1 linux)
patch({ id: 'opt:popup-wayland', file: 'dist/main/preload.js', optional: true,
  find: "electron_1.contextBridge.exposeInMainWorld('modelMenuPopupAPI', modelMenuPopupAPI);",
  replace: "/* mmx-linux */ if (process.platform !== 'linux') electron_1.contextBridge.exposeInMainWorld('modelMenuPopupAPI', modelMenuPopupAPI);" });

// opt4: electron-screenshots cria um BrowserView (renderer ~29 MB PSS) no whenReady; aqui só na 1ª captura. MMX_EAGER_SCREENSHOTS=1 volta ao original.
patch({ id: 'perf:lazy-screenshots', file: 'dist/main/modules/screenshot/index.js', optional: true,
  find: "function initScreenshots() {\n    try {",
  replace: "function initScreenshots() { /* mmx-linux opt4: lazy */\n    if (process.env.MMX_EAGER_SCREENSHOTS === '1') mmxInitScreenshotsNow();\n}\nfunction mmxInitScreenshotsNow() {\n    try {" });
patch({ id: 'perf:lazy-screenshots-start', file: 'dist/main/modules/screenshot/index.js', optional: true,
  find: "async function startScreenshot(workspaceDir) {\n    if (!screenshotsInstance) {",
  replace: "async function startScreenshot(workspaceDir) {\n    if (!screenshotsInstance && typeof mmxInitScreenshotsNow === 'function') mmxInitScreenshotsNow(); /* mmx-linux opt4 */\n    if (!screenshotsInstance) {" });

// opt2: perf:compile-cache-main/utility removidos (sem ganho medido: import isolado do grafo v2, 4x4 intercalado, user 11,95 s sem vs 12,0 s com; logs/opt2-cc-standalone.txt).
// strip de arquivos de dev de @mavis/local-runtime-v2 (lista fixa). aborta se main/exports (fora de "types") apontarem para algo removido.
{
  const id = 'perf:strip-lrv2', pdir = path.join(NM, '@mavis/local-runtime-v2');
  const STRIP = ['src', 'docs', 'fixtures', 'test-support', 'scripts', 'AGENTS.md', 'MIGRATION-NOTES.md', 'dependency-cruiser.config.mjs',
    'tsconfig.json', 'tsconfig.typecheck.json', 'vitest.config.ts', 'vitest.memory-real.config.ts', 'dist/tsconfig.tsbuildinfo'];
  if (!fs.existsSync(path.join(pdir, 'package.json'))) fail(`${id}: pacote ausente`);
  const pj = JSON.parse(fs.readFileSync(path.join(pdir, 'package.json'), 'utf8'));
  const targets = [pj.main];
  const walk = (v, k) => { if (typeof v === 'string') { if (k !== 'types') targets.push(v); } else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, kk); };
  walk(pj.exports); walk(pj.bin);
  for (const t of targets.filter(Boolean)) {
    const rel = path.normalize(t).replace(/^\.\//, '');
    if (STRIP.some((s) => rel === s || rel.startsWith(s + '/'))) fail(`${id}: package.json aponta para ${t}, que seria removido`);
    if (!rel.startsWith('dist/')) fail(`${id}: entrada fora de dist/: ${t}`);
  }
  let n = 0;
  for (const s of STRIP) { const p = path.join(pdir, s); if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true }); n++; } else warnings.push(`${id}: ${s} já ausente`); }
  applied.push(`${id} (${n}/${STRIP.length} itens)`);
}

// fix1 (2026-10-19): thread principal do utility local-runtime a ~100% de CPU => timers atrasados em bloco (content-safety, token counter,
// eval upload) => `content.retry.exceeded` + `message.rewind` ("negado pelo provedor"/espera longa). causa medida por CPU profile:
// fs.watch recursive (polyfill JS no linux) do workspace indexing re-varrendo a árvore a cada evento (inclusive o log do próprio app).
{
  const WI = 'node_modules/@mavis/local-runtime/dist/workspace-indexing/';
  const helper = path.join(ROOT, 'patches/linux-files/app', WI, 'mmx-linux-watch.js');
  if (!fs.existsSync(helper)) fail('fix:indexing-watcher: helper ausente em patches/linux-files');
  put(helper, path.join(APP, WI, 'mmx-linux-watch.js'));
  applied.push('files:mmx-linux-watch.js');
  patch({ id: 'fix:indexing-watcher-import', file: WI + 'prewarm-coordinator.js',
    find: "import { watch as watchFs } from 'node:fs';\n",
    replace: "import { watch as watchFs } from 'node:fs';\nimport { mmxWatchWorkspace } from './mmx-linux-watch.js'; /* mmx-linux */\n" });
  patch({ id: 'fix:indexing-watcher', file: WI + 'prewarm-coordinator.js',
    find: "function watchWorkspaceDefault(workspaceDir, onChange, onError) {\n",
    replace: "function watchWorkspaceDefault(workspaceDir, onChange, onError) {\n    if (process.platform === 'linux' && process.env.MMX_RECURSIVE_WATCH !== '1') /* mmx-linux: sem polyfill recursivo */\n        return mmxWatchWorkspace(workspaceDir, onChange, onError);\n" });
  patch({ id: 'fix:indexing-debounce', file: WI + 'prewarm-coordinator.js',
    find: 'const DEFAULT_PREWARM_REFRESH_DEBOUNCE_MS = 500;',
    replace: 'const DEFAULT_PREWARM_REFRESH_DEBOUNCE_MS = Number(process.env.MMX_PREWARM_DEBOUNCE_MS) || 5000; /* mmx-linux: 500 -> 5000 */' });
}
// fix2: revisão de conteúdo. (a) sem veredito por falha de transporte/http/upstream => api_error (segue como o V1 já faz para 5xx; auth continua fechado).
// MMX_SAFETY_FAIL_OPEN=0 volta ao original. (b) timeout 10 s -> 6 s (MMX_SAFETY_TIMEOUT_MS). (c) janela de revisão de stream 80 -> 600 caracteres
// (cada janela era 1 request HTTP sequencial; MMX_SAFETY_CHUNK_THRESHOLD).
patch({ id: 'fix:safety-fail-open', file: 'node_modules/@mavis/local-runtime-v2/dist/service/content-safety/transport/turn-api.js',
  find: "errorKind: error instanceof SafetyCheckV2Error && error.kind === 'auth' ? 'auth_error' : 'local_error',",
  replace: "errorKind: error instanceof SafetyCheckV2Error && error.kind === 'auth' ? 'auth_error'\n                : (process.env.MMX_SAFETY_FAIL_OPEN !== '0' && error instanceof SafetyCheckV2Error && ['transport', 'http', 'upstream', 'response'].includes(error.kind)) ? 'api_error' : 'local_error', /* mmx-linux */" });
patch({ id: 'fix:safety-timeout', file: 'node_modules/@mavis/shared/dist/safety-check-v2.js',
  find: 'const timeout = AbortSignal.timeout(10_000);',
  replace: 'const timeout = AbortSignal.timeout(Number(process.env.MMX_SAFETY_TIMEOUT_MS) || 6_000); /* mmx-linux */' });
patch({ id: 'fix:safety-chunk', file: 'node_modules/@mavis/local-runtime-v2/dist/service/turn-system/agent-host/runner/output-safety-event-writer.js',
  find: 'export const OUTPUT_SAFETY_CHUNK_THRESHOLD = 80;',
  replace: 'export const OUTPUT_SAFETY_CHUNK_THRESHOLD = Number(process.env.MMX_SAFETY_CHUNK_THRESHOLD) || 600; /* mmx-linux */' });

// opt3: bundle esbuild dos grafos ESM do utility local-runtime (import 13,5 s -> ver LOG opt3). opcional: falha => aviso, app segue com import original.
// runtime: importEsm usa o bundle para os 3 specifiers; se o bundle faltar/falhar, volta ao import original (todos juntos, sem misturar instâncias).
// desligar: MMX_NO_RUNTIME_BUNDLE=1 (runtime) ou MMX_NO_BUNDLE_BUILD=1 (apply).
if (process.env.MMX_NO_BUNDLE_BUILD === '1') warnings.push('perf:runtime-bundle: pulado (MMX_NO_BUNDLE_BUILD=1)');
else {
  const id = 'perf:runtime-bundle', UT = 'dist/main/modules/local-runtime/utility/';
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'patches/bundle/runtime-bundle.mjs'), APP, path.join(APP, UT, 'mmx-runtime-bundle')], { stdio: ['ignore', 'inherit', 'inherit'] });
    patch({ id, file: UT + 'entry.js', optional: true,
      find: "function importEsm(specifier) {\n    if (useVitestImport) {",
      replace: `const __mmxBundleMap = { '@mavis/local-runtime-v2': 'v2.mjs', '@mavis/local-runtime/common': 'common.mjs', '@mavis/local-runtime-v2/wechat-sdk': 'wechat.mjs' };
let __mmxBundleCore = null; /* mmx-linux opt3: promise do bundle v2+common (carregados juntos para não misturar instâncias) */
function __mmxNativeImport(s) { return new Function('specifier', 'return import(specifier)')(s); }
function importEsm(specifier) {
    const __f = __mmxBundleMap[specifier];
    if (__f && !useVitestImport && process.env.MMX_NO_RUNTIME_BUNDLE !== '1' && __mmxBundleCore !== false) {
        const dir = require('node:path').join(__dirname, 'mmx-runtime-bundle');
        const url = (f) => require('node:url').pathToFileURL(require('node:path').join(dir, f)).href;
        if (__mmxBundleCore === null) {
            __mmxBundleCore = require('node:fs').existsSync(require('node:path').join(dir, 'v2.mjs'))
                ? Promise.all([__mmxNativeImport(url('v2.mjs')), __mmxNativeImport(url('common.mjs'))]) : false;
            if (__mmxBundleCore) console.warn('[mmx-linux] local-runtime: usando bundle ' + dir);
            else console.warn('[mmx-linux] local-runtime: bundle ausente, import original');
        }
        if (__mmxBundleCore) {
            const core = __mmxBundleCore;
            const fallback = (e) => { console.warn('[mmx-linux] local-runtime: bundle falhou, import original:', e && (e.stack || e)); if (__mmxBundleCore === core) __mmxBundleCore = false; return importEsm(specifier); };
            if (__f === 'v2.mjs') return core.then((m) => m[0], fallback);
            if (__f === 'common.mjs') return core.then((m) => m[1], fallback);
            return core.then(() => __mmxNativeImport(url(__f)), fallback);
        }
    }
    if (useVitestImport) {` });
  } catch (e) { warnings.push(`${id}: bundle não gerado (${String(e.message).split('\n')[0]}); runtime usa import original`); }
}

// camada 6: integração desktop. app_id wayland/WM_CLASS vem do desktopName (sem ele: "mmx-agent-electron", sem .desktop => ícone genérico)
{
  const pjPath = path.join(APP, 'package.json');
  const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  pj.desktopName = 'minimax-code.desktop';
  fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n');
  applied.push('desk:desktopName (package.json => app_id minimax-code)');
  // ícones hicolor extraídos do icon.icns oficial (chunks PNG) + .desktop modelo em app-linux/share
  const icns = fs.readFileSync(path.join(OUT, 'resources/resources/icon.icns'));
  const sizes = { ic11: 32, ic12: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024 };
  let n = 0;
  for (let i = 8; i + 8 <= icns.length;) {
    const type = icns.toString('latin1', i, i + 4), len = icns.readUInt32BE(i + 4), body = icns.subarray(i + 8, i + len);
    if (sizes[type] && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      const s = sizes[type], dst = path.join(OUT, `share/icons/hicolor/${s}x${s}/apps/minimax-code.png`);
      fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, body); n++;
    }
    if (len < 8) break; i += len;
  }
  if (n < 4) fail(`desk:icons: só ${n} tamanhos PNG no icon.icns`);
  fs.mkdirSync(path.join(OUT, 'share/applications'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'share/applications/minimax-code.desktop'), [
    '[Desktop Entry]', 'Type=Application', 'Name=MiniMax Code', 'Comment=MiniMax Code (unofficial Linux port)',
    'Exec=minimax-code %U', 'Icon=minimax-code', 'StartupWMClass=minimax-code', 'StartupNotify=true',
    'Categories=Development;Utility;', 'MimeType=x-scheme-handler/minimax;x-scheme-handler/minimax-agent;', 'Terminal=false', ''].join('\n'));
  applied.push(`desk:icons (${n} tamanhos de icon.icns + share/applications/minimax-code.desktop)`);
}

// marca
const FIN_OUT = FINAL;
fs.writeFileSync(path.join(OUT, '.mmx-linux.json'), JSON.stringify({ version: ver, applied, warnings, at: new Date().toISOString() }, null, 1) + '\n');
// commit atômico: app-linux anterior vai para .prev (lixeira) só depois de o novo estar pronto
const PREV = FINAL + '.prev';
fs.rmSync(PREV, { recursive: true, force: true });
if (fs.existsSync(FINAL)) fs.renameSync(FINAL, PREV);
fs.renameSync(OUT, FINAL);
committed = true;
if (fs.existsSync(PREV)) {
  fs.rmSync(PREV, { recursive: true, force: true });
}
console.log(`patches aplicados (${applied.length}):`);
for (const a of applied) console.log(`  ok  ${a}`);
for (const w of warnings) console.log(`  aviso  ${w}`);
console.log(`saída: ${FINAL}`);
