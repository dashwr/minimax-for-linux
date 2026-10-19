# Stability fixes

Symptoms on Linux: new chats waited a long time, messages showed "denied by provider" with a Retry button,
and long conversations failed more often than short ones. The CLI was unaffected.

## Cause

The local-runtime process (`--utility-sub-type=node.mojom.NodeService`) had its main thread at 97% CPU.
A CPU profile (inspector via `SIGUSR1`, 8 s) showed the time in `excludesWorkspacePath` and in
`node:internal/fs/recursive_watch`, called from `watchWorkspaceDefault` in the workspace indexing
(`workspace-indexing/prewarm-coordinator.js`). On Linux, `fs.watch(dir, { recursive: true })` is a JavaScript
emulation that registers one watcher per file and re-scans the tree on every event. The app's own log file
was inside the watched workspace, so it fed itself.

With the loop saturated, timers fired late and together: the 10 s content review, the 3 s token counter and
the eval upload failed in the same millisecond. Output is reviewed before it is shown, every 80 characters,
one request at a time, and four consecutive failures stop the turn (`content.retry.exceeded` followed by
`message.rewind`). Longer answers mean more reviews and more chances to fail.

Ruled out: network (the same endpoint answered in 0.3–1.3 s from the app's own Electron), conversation size
(affected sessions had 14–34 messages) and the tokenizer (1.6 M characters in 173 ms).

## Patches

All in `patches/apply.mjs`, applied before the runtime bundle is built:

| Patch | Change |
| --- | --- |
| `fix:indexing-watcher`, `-import` | non-recursive watcher (`mmx-linux-watch.js`) that prunes noise directories before registering, caps at 3000 directories, scans asynchronously |
| `fix:indexing-debounce` | refresh debounce 500 ms to 5000 ms |
| `fix:safety-fail-open` | transport, HTTP, upstream and response failures of the V2 content review become `api_error` (the V1 path already treats 5xx this way); `auth` stays closed |
| `fix:safety-timeout` | review timeout 10 s to 6 s |
| `fix:safety-chunk` | streamed-output review window 80 to 600 characters |

## Checks

- Watcher on a 34k-file workspace: 327 directories watched, 48 ms of CPU, `node_modules` and `logs` ignored, new directories picked up.
- Patched review with a simulated `fetch`: hang gives `api_error` after the timeout, 500 gives `api_error`, 401 gives `auth_error`, allow and block are unchanged, `MMX_SAFETY_FAIL_OPEN=0` gives `local_error`.
- Not verified here: runtime CPU in a logged-in session after the change.

## Trade-off

Failing open on a missing content-review verdict weakens a moderation gate that upstream keeps closed.
Set `MMX_SAFETY_FAIL_OPEN=0` to keep the upstream behavior.
