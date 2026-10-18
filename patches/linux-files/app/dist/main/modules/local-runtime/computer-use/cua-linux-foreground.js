"use strict";
// mmx-linux: fallback de input foreground no KDE Plasma wayland (cua-driver 0.22.1 recusa com foreground_unavailable).
// fluxo: ativa a janela-alvo por script KWin (DBus) -> cria dispositivo uinput absoluto (helper python stdlib) ->
// re-verifica janela ativa + ponto dentro da geometria -> só então injeta. qualquer dúvida: aborta sem input.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isForegroundUnavailable = isForegroundUnavailable;
exports.linuxForegroundFallback = linuxForegroundFallback;
exports.withLinuxForegroundFallback = withLinuxForegroundFallback;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_util_1 = require("node:util");
const execFile = (0, node_util_1.promisify)(node_child_process_1.execFile);
const TOOLS = new Set(['click', 'double_click', 'type_text', 'press_key', 'hotkey', 'scroll']);
function helperPath() {
    if (process.env.MMX_LINUX_INPUT_HELPER)
        return process.env.MMX_LINUX_INPUT_HELPER;
    // __dirname = <resources>/app/dist/main/modules/local-runtime/computer-use
    return (0, node_path_1.join)((0, node_path_1.resolve)(__dirname, '../../../../../..'), 'resources', 'linux-input', 'uinput.py');
}
function enabled() {
    return process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY &&
        /KDE/i.test(process.env.XDG_CURRENT_DESKTOP ?? '') && process.env.MMX_CUA_KWIN_FALLBACK !== '0';
}
function isForegroundUnavailable(result) {
    if (!result?.isError)
        return false;
    const s = `${result.text ?? ''} ${result.structuredJson ?? ''}`;
    return s.includes('foreground_unavailable');
}
/** Wrapper do ponto de chamada: só age se o driver recusou foreground. */
async function withLinuxForegroundFallback(runtime, name, payload, signal, call) {
    const result = await call();
    if (!enabled() || !TOOLS.has(name) || payload?.delivery_mode !== 'foreground' || !isForegroundUnavailable(result))
        return result;
    try {
        return await linuxForegroundFallback(runtime, name, payload, signal);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, text: `${result.text ?? ''}\nkwin-uinput fallback NOT sent: ${msg}`,
            structuredJson: JSON.stringify({ code: 'computer_foreground_fallback_refused', effect: 'refused', via: 'kwin-uinput', reason: msg }) };
    }
}
// ---- KWin scripting via DBus (qdbus6) ----
async function kwinScript(body, signal) {
    const nonce = `MMXK${process.pid}x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const dir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'mmx-kwin-'));
    const file = (0, node_path_1.join)(dir, 's.js');
    (0, node_fs_1.writeFileSync)(file, `(function(){ var R = {}; try { ${body} } catch (e) { R.error = String(e); } print("${nonce} " + JSON.stringify(R)); })();\n`);
    try {
        const { stdout } = await execFile('qdbus6', ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.loadScript', file, nonce], { signal });
        const id = stdout.trim();
        if (!/^\d+$/.test(id))
            throw new Error(`kwin loadScript falhou: ${stdout.trim()}`);
        await execFile('qdbus6', ['org.kde.KWin', `/Scripting/Script${id}`, 'org.kde.kwin.Script.run'], { signal }).catch(() => undefined);
        for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 100));
            const { stdout: j } = await execFile('journalctl', ['--user', '-b', '--since', '-15s', '-o', 'cat', '--no-pager'], { signal, maxBuffer: 32 << 20 });
            const line = j.split('\n').find((l) => l.includes(nonce + ' '));
            if (line)
                return JSON.parse(line.slice(line.indexOf(nonce + ' ') + nonce.length + 1));
        }
        throw new Error('kwin script sem resposta no journal');
    }
    finally {
        await execFile('qdbus6', ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.unloadScript', nonce]).catch(() => undefined);
        (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
    }
}
const geo = (g) => ({ x: g.x, y: g.y, width: g.width, height: g.height });
function kwinFind(pid, title) {
    // seleciona por pid; se houver várias janelas normais do pid, exige título exato do driver
    return `var c = workspace.windowList().filter(function(w){ return w.pid === ${Number(pid)} && w.normalWindow && !w.minimized; });
      if (c.length > 1) c = c.filter(function(w){ return w.caption === ${JSON.stringify(title ?? '')}; });
      R.count = c.length; var w = c.length === 1 ? c[0] : null;`;
}
function report() {
    return `var a = workspace.activeWindow; var s = workspace.virtualScreenSize;
      R.screen = { width: s.width, height: s.height };
      if (w) { R.target = { id: String(w.internalId), caption: w.caption, pid: w.pid, client: ${'{'}x: w.clientGeometry.x, y: w.clientGeometry.y, width: w.clientGeometry.width, height: w.clientGeometry.height${'}'} }; }
      R.active = a ? { id: String(a.internalId), pid: a.pid, caption: a.caption } : null;
      R.isActive = !!(w && a && a === w);`;
}
// ---- mapeamento de teclas (evdev, layout US) ----
const KEY = { esc: 1, escape: 1, minus: 12, equal: 13, backspace: 14, tab: 15, enter: 28, return: 28, ctrl: 29, control: 29, space: 57,
    shift: 42, alt: 56, option: 56, super: 125, meta: 125, cmd: 125, command: 125, win: 125, delete: 111, del: 111, insert: 110,
    home: 102, end: 107, pageup: 104, pagedown: 109, up: 103, down: 108, left: 105, right: 106 };
'qwertyuiop'.split('').forEach((c, i) => (KEY[c] = 16 + i));
'asdfghjkl'.split('').forEach((c, i) => (KEY[c] = 30 + i));
'zxcvbnm'.split('').forEach((c, i) => (KEY[c] = 44 + i));
'1234567890'.split('').forEach((c, i) => (KEY[c] = 2 + i));
for (let i = 1; i <= 10; i++)
    KEY['f' + i] = 58 + i;
KEY.f11 = 87;
KEY.f12 = 88;
const PLAIN = { ' ': 57, '-': 12, '=': 13, '[': 26, ']': 27, ';': 39, "'": 40, '`': 41, '\\': 43, ',': 51, '.': 52, '/': 53, '\n': 28, '\t': 15 };
const SHIFTED = { '!': 2, '@': 3, '#': 4, $: 5, '%': 6, '^': 7, '&': 8, '*': 9, '(': 10, ')': 11, _: 12, '+': 13, '{': 26, '}': 27, ':': 39, '"': 40, '~': 41, '|': 43, '<': 51, '>': 52, '?': 53 };
function charOps(ch) {
    let code, shift = false;
    if (/^[a-z0-9]$/.test(ch))
        code = KEY[ch];
    else if (/^[A-Z]$/.test(ch)) {
        code = KEY[ch.toLowerCase()];
        shift = true;
    }
    else if (ch in PLAIN)
        code = PLAIN[ch];
    else if (ch in SHIFTED) {
        code = SHIFTED[ch];
        shift = true;
    }
    if (!code)
        throw new Error(`caractere sem mapeamento uinput (layout US): ${JSON.stringify(ch)}`);
    return shift ? [['key', 42, 1], ['key', code, 1], ['key', code, 0], ['key', 42, 0]] : [['key', code, 1], ['key', code, 0]];
}
function chordOps(keys) {
    const codes = keys.map((k) => {
        const c = KEY[String(k).toLowerCase()];
        if (!c)
            throw new Error(`tecla sem mapeamento uinput: ${k}`);
        return c;
    });
    return [...codes.map((c) => ['key', c, 1]), ...codes.reverse().map((c) => ['key', c, 0])];
}
/** Monta as operações (sem coordenadas de tela ainda). Lança antes de qualquer input se algo não for suportado. */
function planOps(name, p) {
    const hasPoint = typeof p.x === 'number' && typeof p.y === 'number';
    const ops = [];
    const click = (n, button) => { for (let i = 0; i < n; i++)
        ops.push(['btn', button, 1], ['btn', button, 0], ['sleep', 60]); };
    switch (name) {
        case 'click':
        case 'double_click':
            if (!hasPoint)
                throw new Error('click sem x/y (element_token) não suportado no fallback');
            click(name === 'double_click' ? 2 : Number(p.count ?? 1), p.button ?? 'left');
            break;
        case 'type_text':
            if (hasPoint)
                click(1, 'left');
            for (const ch of String(p.text ?? ''))
                ops.push(...charOps(ch));
            break;
        case 'press_key':
            if (hasPoint)
                click(1, 'left');
            ops.push(...chordOps([...(Array.isArray(p.modifiers) ? p.modifiers : []), p.key]));
            break;
        case 'hotkey':
            if (hasPoint)
                click(1, 'left');
            ops.push(...chordOps(p.keys ?? []));
            break;
        case 'scroll': {
            const n = Number(p.amount ?? 3), d = String(p.direction ?? 'down');
            const map = { up: ['wheel', 1], down: ['wheel', -1], left: ['hwheel', -1], right: ['hwheel', 1] };
            if (!map[d])
                throw new Error(`direção de scroll inválida: ${d}`);
            for (let i = 0; i < n; i++)
                ops.push([map[d][0], map[d][1]]);
            break;
        }
        default:
            throw new Error(`ferramenta não suportada: ${name}`);
    }
    if (!['left', 'right', 'middle'].includes(p.button ?? 'left'))
        throw new Error(`botão inválido: ${p.button}`);
    return { ops, hasPoint };
}
async function driverWindowTitle(runtime, p, signal) {
    if (!runtime?.callTool)
        return undefined;
    try {
        const r = await runtime.callTool('list_windows', { pid: p.pid, session: p.session }, signal);
        const ws = JSON.parse(r?.structuredJson ?? '{}').windows ?? [];
        return ws.find((w) => w.window_id === p.window_id)?.title;
    }
    catch {
        return undefined;
    }
}
function startHelper(screen) {
    const child = (0, node_child_process_1.spawn)('python3', [helperPath()], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', err = '';
    const waiters = [];
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        waiters.shift()?.res(l);
    } });
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => { while (waiters.length)
        waiters.shift().rej(new Error(`helper uinput saiu (${code}): ${err.trim().slice(0, 300)}`)); });
    child.on('error', (e) => { while (waiters.length)
        waiters.shift().rej(e); });
    const next = (ms = 10000) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('helper uinput timeout')), ms);
        waiters.push({ res: (l) => { clearTimeout(t); res(JSON.parse(l)); }, rej: (e) => { clearTimeout(t); rej(e); } });
    });
    child.stdin.write(JSON.stringify({ w: screen.width, h: screen.height }) + '\n');
    return { child, next, send: (o) => child.stdin.write(JSON.stringify(o) + '\n') };
}
/** Fallback: ativa via KWin, verifica, injeta via uinput. Devolve resultado no formato do driver com via: kwin-uinput. */
async function linuxForegroundFallback(runtime, name, payload, signal, opts = {}) {
    if (typeof payload?.pid !== 'number')
        throw new Error('pid ausente: fallback exige janela-alvo');
    const { ops, hasPoint } = planOps(name, payload); // valida tudo antes de tocar em input
    const title = opts.title ?? await driverWindowTitle(runtime, payload, signal);
    const find = kwinFind(payload.pid, title);
    const act = await kwinScript(`${find} if (w) workspace.activeWindow = w; ${report()}`, signal);
    if (act.error)
        throw new Error(`kwin: ${act.error}`);
    if (act.count !== 1 || !act.target)
        throw new Error(`janela KWin do pid ${payload.pid} não identificada de forma única (${act.count} candidatas, título ${JSON.stringify(title)})`);
    const helper = startHelper(act.screen);
    try {
        const ready = await helper.next();
        if (!ready.ready)
            throw new Error(`helper uinput: ${JSON.stringify(ready)}`);
        // guarda: re-verifica depois que o dispositivo existe, imediatamente antes de injetar
        const chk = await kwinScript(`${find} ${report()}`, signal);
        const t = chk.target;
        if (!chk.isActive || !t || t.id !== act.target.id)
            throw new Error(`janela ativa não é a alvo (ativa: ${JSON.stringify(chk.active)})`);
        let screenPoint;
        if (hasPoint) {
            screenPoint = { x: Math.round(t.client.x + payload.x), y: Math.round(t.client.y + payload.y) };
            const inside = payload.x >= 0 && payload.y >= 0 && payload.x < t.client.width && payload.y < t.client.height &&
                screenPoint.x < chk.screen.width && screenPoint.y < chk.screen.height;
            if (!inside)
                throw new Error(`ponto (${payload.x},${payload.y}) fora da janela-alvo ${t.client.width}x${t.client.height}`);
        }
        signal?.throwIfAborted();
        helper.send({ go: [...(screenPoint ? [['move', screenPoint.x, screenPoint.y]] : []), ...ops] });
        const done = await helper.next(30000);
        if (!done.done)
            throw new Error(`helper uinput: ${JSON.stringify(done)}`);
        const out = { effect: 'sent', via: 'kwin-uinput', tool: name, pid: payload.pid, window_id: payload.window_id,
            kwin_window: { id: t.id, caption: t.caption, geometry: geo(t.client) }, ...(screenPoint ? { screen_point: screenPoint } : {}) };
        return { isError: false, text: `${name} sent via kwin-uinput to "${t.caption}" (pid ${payload.pid})${screenPoint ? ` at screen ${screenPoint.x},${screenPoint.y}` : ''}`, structuredJson: JSON.stringify(out) };
    }
    catch (e) {
        try {
            helper.send({ abort: true });
        }
        catch { }
        throw e;
    }
    finally {
        setTimeout(() => helper.child.kill(), 2000).unref();
    }
}
