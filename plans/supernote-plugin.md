# Supernote Plugin

A plugin for Supernote tablets to send and receive WRTN messages (handwritten
strokes) over the network, peer-to-peer via a relay server.

## Status

**Verified end-to-end on a Nomad A6X2 (2026-08-21):** a stylus stroke drawn in
an open note is captured, sent over HTTPS to a relay server, mirrored by the
built-in `echo` user, and a gray offset copy renders back in the same note
within ~1–2 s. Inbound strokes from any peer render live on the current page.

| capability | state |
| --- | --- |
| Monorepo + TS strict + Vitest | ✅ 53 tests |
| sn-stub mock SDK (in-memory) | ✅ |
| Versioned, transport-agnostic protocol | ✅ |
| HTTP long-poll transport (fetch) | ✅ on-device |
| Relay server (zero-dep Node) | ✅ |
| Echo transform (+2.5 %, gray `0x9D`) | ✅ on-device |
| Plugin scaffold (RN bundle + `.snplg`) | ✅ |
| Headless session lifecycle | ✅ |
| pen-up → capture → send | ✅ on-device |
| remote stroke → live render | ✅ on-device |
| `.note` config persistence | ⚠️ partial (template API fails on-device; username falls back to random) |

## Workflow

- Plugin runtime boots when its toolbar button is opened; `index.js` calls
  `startSession()` unconditionally so the headless path works too.
- On connect the plugin registers a random `word-word-N` username and
  auto-invites the `echo` bot (every session has someone to talk to).
- `event_pen_up` → `getLastElement()` → normalize to `0..1` over the device's
  EMR range → `strokes` envelope → server.
- Inbound `strokes` → `createElement(0)` + `setRange` bulk-insert →
  `insertElements(notePath, currentPage, [el])` → `saveCurrentNote` →
  `reloadFile` (live redraw).
- The "WRTN Setup" button opens a fullscreen status UI (identity, members,
  invite, server URL, log tail, ‹ note back button). The "WRTN" button is
  headless (`showType: 0`).

## Dev loop

```sh
# relay server (host) — bind 0.0.0.0:8001, proxied by Tailscale Serve HTTPS
npm run server                 # WRTN_PORT=8001 default

# device
adb connect 100.103.149.40:5555
npm run deploy:plugin          # build + push + install .snplg (stable pluginID)
npm run logs                   # live ReactNativeJS / PluginApp / host logs
npm run logs:capture           # one-shot recent buffer, noise filtered
```

### Hot reload (no reinstall)

The plugin host ships a debug receiver that swaps the JS bundle in place
(`scripts/snplg-hotreload.sh` wraps it):

```sh
npm run reload:plugin     # build + push + broadcast
```

`bundle_path` must be world-readable (under `/storage/emulated/0/…`); extras
are snake_case (`bundle_path`, `plugin_id`). This re-runs `index.js` in the
**note-app context** (so the file APIs are usable), re-registers buttons, and
restarts the session.

```sh
npm run build:plugin
adb push packages/plugin/build/generated/wrtnplugin.bundle \
    /storage/emulated/0/MyStyle/wrtnplugin.bundle
adb shell am broadcast \
  -n com.ratta.supernote.pluginhost/.receiver.PluginReceiver \
  -a com.ratta.supernote.plugin.action.DEBUG -f 0x01000000 \
  --es bundle_path "/storage/emulated/0/MyStyle/wrtnplugin.bundle" \
  --es plugin_id "wrtnsync00000001"
```

`bundle_path` must be world-readable (under `/storage/emulated/0/…`); extras
are snake_case (`bundle_path`, `plugin_id`). This re-runs `index.js` in the
**note-app context** (so the file APIs are usable), re-registers buttons, and
restarts the session.

`bundle_path` must be world-readable (under `/storage/emulated/0/…`); extras
are snake_case (`bundle_path`, `plugin_id`). This re-runs `index.js` in the
**note-app context** (so the file APIs are usable), re-registers buttons, and
restarts the session.

## Verified device facts (2026-08-21, Nomad A6X2)

- **Cleartext HTTP is blocked.** The plugin host targets API ≥ 28 with no
  `usesCleartextTraffic` / `networkSecurityConfig`, so OkHttp rejects
  `http://` with a generic "Network request failed" (HTTPS to the same host on
  a public cert works). **Use Tailscale Serve** to front the server with a
  valid tailnet cert: `sudo tailscale serve --bg 8001` →
  `https://<host>.ts.net`. Plugin default:
  `https://macmini.rhino-dragon.ts.net`.
- **`points.add()` (INSERT_POINT_AT_INDEX) hangs.** `CommAPIModule.opTrail`
  inserts the point via `addAll` but never resolves the promise. **Use
  `setRange(0, N, allPoints)`** — its native handler does
  remove-loop (no-op on empty) → `addAll` → `resolve(true)`. This is the only
  point-write that both inserts and resolves.
- **`insertElements` drops trails with `layerNum ≠ 0` or `maxX/maxY == 0`.**
  The note app returns `insertCount:0` (→ error 106) silently. Always set
  `layerNum = 0` (Main Layer) and real bounding-box maxima.
- **Remote strokes must target the *receiver's* current page.** The sender's
  page index is meaningless across devices; the core reads
  `getCurrentPageNum()` and retargets.
- **Finger/touch input does not create strokes** on the EMR digitizer — only
  the stylus draws (and only the stylus flips pages). Toolbar buttons *do*
  respond to finger taps; the plugins popup is custom-drawn and invisible to
  `uiautomator`.
- **API context gating.** File APIs (`getElements`, `createNote`,
  `insertElements`, …) return error 102 when the plugin runs from the Settings
  client (install) and error 1201/106 from a note context when the file is
  absent/invalid. The debug hot-reload launches in the note context — correct.
- **`getNoteSystemTemplates()` fails on-device** (`undefined undefined`) with
  the installed SDK build, so the `.note` config store can't create its
  config note; the username falls back to a fresh random one per session.
  Persistence is deferred until that API or an alternative lands.
- **`closePluginView()` stops the runtime** (host calls `stopPlugin`); a
  long-running session needs the `showType: 0` headless button. The core
  re-invites `echo` whenever it finds itself solo (e.g. after a peer leaves).
- **Display sleep pauses delivery.** Keep the screen on during E2E
  (`adb shell svc power stayon true`); long-polls resume on wake.
- **`setTimeout` does not fire in the plugin RN/Hermes runtime** (a 2000 ms
  probe never fired after 8 s). This blocks timer-based debouncing of
  renders/reconnects; the transport's backoff is therefore slow. Use
  promise chains or network round-trips to serialize, not timers.
- **Echo render requires `reloadFile()`** — `insertElements` writes the note
  file but the live e-ink view stays stale without a reload (verified: no
  echo appears if reload is skipped). `reloadFile` does a full-page refresh
  (clear + redraw all trails), which **flashes** the screen once per echo
  batch. The note app has an internal `refreshCurrentPage` (lighter) but it
  is not exposed via the SDK, and `setTimeout`-based coalescing is out (see
  above). v1 accepts one flash per echo; render order is
  `saveCurrentNote` → `insertElements` → `reloadFile` (save first persists
  the user's just-drawn in-memory stroke so the reload doesn't discard it).

## Loop protection

A stroke we insert from a remote user does **not** fire `event_pen_up` on
this device (verified), but the guards stay as insurance:

1. `insertedUuids` set — the just-created element uuid is skipped on capture.
2. `suppressUntil = now + SUPPRESS_MS` (1000 ms) window after
   insert + `reloadFile`.

## v1 limitations

- Drawn strokes land on the *current* page only; there is no page-navigation
  API (confirmed upstream gap).
- Cleartext is blocked; the server must be HTTPS. Tailscale Serve is the
  documented path; any reverse proxy with a trusted cert works.
- Config persistence (username) is best-effort until the templates API works.
- Strokes drawn within ~1 s of an inserted echo are suppressed (loop guard).
- **Echo render flashes the screen** (one full-page e-ink refresh per echo
  batch). No SDK path to a partial/local redraw; `setTimeout`-based
  debouncing is unavailable in the runtime.
- `setTimeout` does not fire in the plugin runtime, so transport reconnect
  backoff is slow and renders can't be timer-coalesced.
- No WASM / Web Crypto in Hermes; usernames are timestamp+counter+random, not
  crypto-random (fine for this threat model; revisit if needed).

## Relevant links

- SDK: https://www.npmjs.com/package/sn-plugin-lib
- Template: https://www.npmjs.com/package/@supernote-plugin/template
- Official docs: https://docs.supernote.com/en (`/llms.txt`)
- Community research: https://github.com/apclark31/supernote-plugin-research
- Plugin `fetch` proof: https://github.com/guibor/supernote-endpoint-lasso
- Hermes lacks WebAssembly: https://github.com/facebook/hermes/issues/429
