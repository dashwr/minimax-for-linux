<p align="center">
  <img src="docs/logo.png" width="128" alt="MiniMax Code logo">
</p>

<h1 align="center">MiniMax Code for Linux</h1>

<p align="center">Unofficial Linux x64 port of the MiniMax Code desktop app, built from the official macOS release.</p>

> [!WARNING]
> **This is not an official MiniMax product.** It is not affiliated with, endorsed by, or supported by MiniMax.
> "MiniMax", "MiniMax Code" and the logo are trademarks of their respective owner. Use at your own risk.
> Report port issues here, not to MiniMax.

## What this is

MiniMax Code ships only for macOS and Windows. This repository contains a reproducible pipeline that:

1. downloads the official macOS x64 build from MiniMax's update feed and verifies its SHA-512;
2. extracts the Electron app (`app.asar`) and its resources;
3. replaces macOS native modules with Linux builds, compiled from source or taken from npm with integrity checks;
4. applies small, anchored patches so the app runs on Linux;
5. packages everything as a regular Electron Linux layout, with a launcher, `.desktop` entry and icons.

The repository contains **no MiniMax code and no third-party binaries**: scripts and patches only.
Everything else is fetched from its original source when you build.

Current version: **3.1.3** (Electron 42.8.0, x64).

## What changed compared to the macOS app

Every patch is anchored to an exact code location. If a required anchor is missing (for example, after
an upstream update), the build aborts and keeps the previous build intact. Optional patches only print
a warning.

### Native modules

- `node-pty` and `better-sqlite3` are rebuilt for Electron 42.8.0 (ABI 146).
- Linux packages replace the macOS ones for `@trycua/cua-driver`, `@ubjs/node`, `node-screenshots` and `@mariozechner/clipboard`.
- `ripgrep` comes from `@vscode/ripgrep-linux-x64`, pinned to the version the app expects.
- Unused darwin/win32 prebuilds and binaries are removed.

### Updates

The macOS auto-updater and hot updater are disabled. The app always uses its bundled renderer, and the
"check for updates" IPCs report that no update is available. To update, rebuild with a newer version.

### Platform

- `getPlatform` reports `linux` to the remote-control bridge.
- The GPU guard is limited to Windows, and the native SQLite loader uses the packaged path.
- The tray menu and model popup have Linux/Wayland-friendly behavior.

### Computer use

- The overlay, pointer and preview code paths are enabled on Linux.
- The cua-driver Wayland backend is turned on.
- Optional KDE Wayland foreground fallback: when the driver reports `foreground_unavailable`, the app
  activates the target window through KWin scripting and injects input via `uinput`, with safety
  checks that the window and point are correct. Disable it with `MMX_CUA_KWIN_FALLBACK=0`.

### Performance

- The local runtime's ESM graph is bundled with esbuild, which cuts runtime startup from about 17 s to
  about 7 s on the test machine. It falls back to the original imports on error, and
  `MMX_NO_RUNTIME_BUNDLE=1` disables it.
- The screenshot `BrowserView` is created lazily, saving about 90 MB RSS and one process.
  `MMX_EAGER_SCREENSHOTS=1` restores the original behavior.
- Development-only files of the local runtime are stripped.

### Desktop integration

- `desktopName` is set so the Wayland `app_id` / X11 `WM_CLASS` is `minimax-code`, which matches the
  installed `.desktop` file. Without it, KDE and GNOME show a generic icon.
- Hicolor icons (32–1024 px) are extracted from the official `icon.icns`.

### Stability fixes

Measured on a real session (CPU profile of the local-runtime process), not guessed. Details and evidence
in [docs/stability-fixes.md](docs/stability-fixes.md).

- The workspace indexing watcher used `fs.watch(..., { recursive: true })`, which on Linux is a JavaScript
  emulation that re-scans the whole tree on every event. It pinned the runtime's main thread near 100% CPU,
  so every timer fired late and in a burst: content reviews timed out, and chats showed "denied by provider"
  or long waits. It is replaced by non-recursive watches that skip `node_modules`, `.git`, virtualenvs,
  build output and logs, with a 5 s refresh debounce. `MMX_RECURSIVE_WATCH=1` restores the original.
- A content review that returns no verdict because of a transport, HTTP or upstream failure no longer aborts
  the turn. Authentication failures still block, and explicit rejections are unchanged.
  `MMX_SAFETY_FAIL_OPEN=0` restores the original behavior. The review timeout drops from 10 s to 6 s
  (`MMX_SAFETY_TIMEOUT_MS`), and streamed output is reviewed in windows of 600 characters instead of 80
  (`MMX_SAFETY_CHUNK_THRESHOLD`), which cuts the number of sequential review requests.

### Not available on Linux

- Session transfer to the cloud: its client is a closed macOS-only binary, and the app disables the feature without it.
- macOS-only computer-use features that rely on CoreGraphics/Accessibility, such as app launch observation.

## Install from a release

1. Download `minimax-code-<version>-linux-x64.tar.gz` and its `.sha256` from
   [Releases](../../releases).
2. Verify the archive and install it:

   ```bash
   sha256sum -c minimax-code-3.1.3-linux-x64.tar.gz.sha256
   tar xzf minimax-code-3.1.3-linux-x64.tar.gz
   cd minimax-code-3.1.3-linux-x64
   ./install.sh
   ```

This installs the app per user, without root:

- the app in `~/.local/lib/minimax-code`;
- the launcher in `~/.local/bin/minimax-code`;
- the menu entry and icons in `~/.local/share`.

Use `PREFIX=/some/path ./install.sh` to install elsewhere, and `./uninstall.sh` to remove it.
Uninstalling never touches your profile (`~/.config/MiniMax Agent`, `~/.minimax`).

## Build it yourself

Requirements:

- Linux x64 with glibc;
- `bash`, `curl`, `unzip`, `tar`, `openssl`, `sha256sum`;
- Node.js ≥ 22 and npm;
- `python3`, `make` and `g++`, for the native rebuild.

```bash
git clone https://github.com/dashwr/minimax-for-linux.git
cd minimax-for-linux
./build.sh 3.1.3            # or: ./build.sh 3.1.3 --package  (also creates dist/*.tar.gz)
./install.sh
```

Each step can also be run on its own:

| Step | Command | Output |
| --- | --- | --- |
| Fetch the official macOS build (~350 MB, SHA-512 verified) | `MMX_VERSION=3.1.3 fetch/fetch.sh` | `build/3.1.3/{app,resources,meta.json}` |
| Fetch and build the Linux runtime | `runtime/setup-runtime.sh` | `runtime/electron-42.8.0`, natives |
| Install esbuild, pinned | `(cd tools && npm ci)` | `tools/node_modules` |
| Patch and assemble the app | `node patches/apply.mjs 3.1.3` | `build/3.1.3/app-linux` |

`fetch/fetch.sh` without `MMX_VERSION` follows the latest version in MiniMax's feed. Newer versions are
untested. If an anchor changed, `apply.mjs` names the failing patch, and only that anchor needs updating.
Pinned versions and their hashes live in `fetch/versions.json`.

## Running

Run `minimax-code`, or open "MiniMax Code" from the application menu.

| Variable | Effect |
| --- | --- |
| `MMX_X11=1` | Use X11/XWayland instead of native Wayland. |
| `MMX_NO_SANDBOX=1` | Disable the Chromium sandbox. Use only if your kernel lacks unprivileged user namespaces and `chrome-sandbox` is not setuid root. |
| `MMX_FLAGS="..."` | Extra Chromium flags. |
| `MMX_CUA_KWIN_FALLBACK=0` | Disable the KDE Wayland computer-use fallback. |
| `MMX_RECURSIVE_WATCH=1` | Use the original recursive workspace watcher. |
| `MMX_SAFETY_FAIL_OPEN=0` | Treat a content review without a verdict as a failure, as upstream does. |
| `MMX_SAFETY_TIMEOUT_MS=<ms>` | Content review timeout (default 6000). |
| `MMX_SAFETY_CHUNK_THRESHOLD=<chars>` | Characters of streamed output per content review (default 600). |

The port uses the same profile directories as the official app. If you also run the official MiniMax
Agent through Wine or another port, close it first, and back up `~/.config/MiniMax Agent` and
`~/.minimax`, because newer versions may migrate the database.

## Status

Tested on CachyOS with KDE Plasma (Wayland), on Intel graphics.

- Works:
  - login, chat, agents and the local runtime;
  - GPU compositing and VA-API status;
  - the Chromium sandbox;
  - clipboard (text and image);
  - computer use through AT-SPI, background input and the KWin fallback;
  - tray, icons and `.desktop` integration.
- Known limits:
  - foreground computer-use input on non-KDE Wayland compositors depends on the compositor;
  - multi-monitor and fractional scaling were not tested;
  - computer use was tested only with US keyboard layouts.

## License

The scripts and patches in this repository are released under the [MIT License](LICENSE).
The MiniMax Code application that the build downloads is proprietary software owned by MiniMax and is
**not** covered by this license. Electron and the native modules keep their own licenses.

---

<sub>Disclaimer: this port, its scripts, patches and documentation were authored with AI assistance by
**Anthropic Claude** and **Xiaomi MiMo**, under human direction. Review the code before running it.</sub>
