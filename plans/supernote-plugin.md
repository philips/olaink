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
| Monorepo + TS strict + Vitest | ✅ 85 tests |
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
| SwapNote page transfer (issue #2) | ✅ unit + in-process E2E (not yet on-device) |

## Workflow

- Plugin runtime boots when its toolbar button is opened; `index.js` calls
  `startSession()` unconditionally so the headless path works too.
- On connect the plugin registers a random `word-word-N` username and
  auto-invites the `echo` bot (every session has someone to talk to).
- `event_pen_up` → `getLastElement()` → normalize to `0..1` over the device's
  EMR range → `strokes` envelope → server.
- Inbound `strokes` are **queued in memory** (no note mutation) until a manual
  pull. `pullPending()` → `saveCurrentNote` → `createElement(0)` + `setRange`
  bulk-insert → `insertElements(notePath, currentPage, [els])` → **one**
  `reloadFile`. This is issue #1: auto-reload per remote stroke flashed the
  page mid-writing and risked discarding in-progress ink.
- Three toolbar buttons: "WRTN Setup" opens a fullscreen status UI (identity,
  members, invite, server URL, pending count + Pull now, log tail, ‹ note back
  button); "WRTN" is headless (`showType: 0`, boots the session); "WRTN Pull"
  is headless and flushes the queue. Pull button ids live in
  `src/buttonIds.ts` (101/102/103).
- Whole-page transfer (SwapNote, issue #2) rides the same session as a second
  envelope type — see "SwapNote page transfer" below. The Setup UI gained a
  "Send current page" section (one button per real member) and a
  "Pages from others" pending counter; the pull button also lights for
  queued pages.

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
  Every build stamps `src/buildStamp.ts` (git short hash + `-dirty` + UTC
  time); the bundle logs `[wrtn] bundle stamp <git> <builtAt>` at startup and
  the core logs it again on session start — check that line after any
  hot-reload to prove which build is actually running.
- **`createNote` requires ABSOLUTE Android paths** (verified on-device
  2026-08-23 by a hot-reload probe): note-root-relative paths
  (`/INBOX/...`, `/Note/...`, `/MyStyle/...`) are all rejected with
  `1204 Invalid file path`, while `/storage/emulated/0/INBOX/...`,
  `/storage/emulated/0/Note/...` and `/storage/emulated/0/MyStyle/...` all
  pass path validation (they then failed with 802 for a bad template —
  see below). `getCurrentFilePath()` returns the same absolute format
  (`/storage/emulated/0/Note/20260822_133655.note`), so the plugin's own
  paths must be built absolute. Note: read APIs (e.g. getNoteTotalPageNum)
  DO accept the relative form. SwapNote notes live in the **INBOX** folder:
  `/storage/emulated/0/INBOX/swapnote-<username>.note`. The SDK has **no
  directory-creation API**, so the name is flat — a `SwapNote/`
  subdirectory would need a one-time adb bootstrap.
- **`'blank'` is not a real template name**: createNote rejects it with
  `802 Background template file does not exist`. The on-device system
  template list (obtained via `getNoteSystemTemplates()` in the note
  context) starts with `style_white` (the blank page), then ruled/grid/
  dot styles. The core uses the first template, falling back to
  `style_white`.
- **`getNoteSystemTemplates()` is context-dependent**: it fails (`undefined
  undefined`) from the settings-client context but works from the note
  context (where the SwapNote code runs). The `.note` config store (settings
  context) still can't create its config note, so the username falls back
  to a fresh random one per session.
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
- **Render requires `reloadFile()`** — `insertElements` writes the note file
  but the live e-ink view stays stale without a reload (verified: no echo
  appears if reload is skipped). `reloadFile` does a full-page refresh (clear
  + redraw all trails), which **flashes** the screen. The note app has an
  internal `refreshCurrentPage` (lighter) but it is not exposed via the SDK,
  and `setTimeout`-based coalescing is out (see above).
- **The host ALSO reloads the visible page after EVERY `insertElements`
  call** (host-log-verified 2026-08-21: `insertPageTrails` → `clearPageStatus`
  → `isNeedReloadLayers true` → full `refreshBitmap 1920×2560` ~250 ms later).
  So a pull must build all queued elements first (createElement + setRange
  per stroke, in-memory) and commit them with **ONE** `insertElements(path,
  page, elements[])` call — per-stroke inserts flash the screen once per
  stroke. `saveCurrentNote` once at pull start, `reloadFile` once at the end.
- **Pending-stroke "notification" is `setButtonState` on the pull button** —
  the SDK has no icon/badge update API for registered buttons (only
  register/unregister + enable/disable). The core toggles the "WRTN Pull"
  button: disabled when the queue is empty, enabled when strokes are
  waiting. On-device (host-log-verified 2026-08-21) the host renders a
  disabled button as **removed from the toolbar entirely** (`menuEnable=
  false`) — the button's appearance is itself the notification symbol.

## Loop protection

A stroke we insert from a remote user does **not** fire `event_pen_up` on
this device (verified), but the guards stay as insurance:

1. `insertedUuids` set — the just-created element uuid is skipped on capture.
2. `suppressUntil = now + SUPPRESS_MS` (1000 ms) window after
   insert + `reloadFile`.
3. For **page appends** the suppression window is set *before* the insert
   loop, because `insertElements` fires pen-up per page in the stub (and the
   device reloads after every insert) — a capture during the append would
   re-send the just-appended strokes as live strokes.

## SwapNote page transfer (issue #2)

Whole-page transfer, distinct from live stroke collaboration:

- **Wire**: `page.send { to, elements[] }` (strokes with normalized `0..1`
  points, text boxes with normalized rects) and `pages.ack { pageIds[] }`.
  The envelope **id is the page identity** — used for dedup, mailbox storage,
  and acks. Strokes normalize over the *sender's* EMR range; text rects over
  the *sender's* page pixel size; the receiver denormalizes with its own
  geometry, so mixed-size devices work.
- **Receiver note**: each real peer gets a dedicated
  `/storage/emulated/0/INBOX/swapnote-<sender>.note` (absolute path —
  createNote rejects relative paths with 1204; flat name since the SDK
  has no directory-creation API), pre-created when the peer appears in the
  session (first system template, fallback `style_white`). Pages are
  appended at the end — never merged into the open page.
- **Send**: `sendCurrentPage(username)` reads the open page's elements
  (`getElements` + `points.getRange` for strokes), normalizes, and sends one
  envelope.
- **Receive**: pages queue in memory (cap 50, per-sender overflow drops the
  oldest, dedup by envelope id). Appending happens without any timer — the
  runtime has no working `setTimeout`, so each **poll round-trip tick**
  (transport `onTick`), pen-up, and manual pull all check "is a SwapNote with
  queued pages open?". Append = `insertNotePage` (blank page at the note's
  size, via `getPageSize`) + denormalized elements + one `reloadFile`; only
  then are the pages acked, so a failed write is retried on redelivery.
- **Server**: per-recipient **in-memory mailbox** (cap 50, oldest evicted).
  Online → immediate delivery *and* buffered; offline → buffered; the whole
  mailbox is flushed on (re)hello and entries removed on ack. No durable
  storage (relay philosophy) — the client queue is the other in-memory half.
  Bug found while testing: a re-hello while the old connection's long-poll
  was in flight used to hand the flush to the *stale* waiter's dead response.
  Fix: token rotation settles the old waiter first (registry `hello`).
- **swaptest bot**: reserved name (like `echo`) that generates random-walk
  pages (`swapTest.ts`); `POST /v1/test/swaptest/page { to }` routes one
  through the normal `page.send` path. Lets a single-device setup exercise
  receive/auto-append/ack end-to-end.
- **Reserved-sender parse bug (found on-device 2026-08-23)**: the SwapNote
  name encodes the *sender*, and swaptest is a reserved name. The first
  implementation validated the parsed sender with `isValidUsername()`, which
  rejects reserved names — so `swapnote-swaptest.note` parsed to `null` and
  pages queued forever without appending. Fix: `isStructurallyValidUsername()`
  (shape check only; reserved names pass) for assigned names, while
  `isValidUsername()` keeps rejecting them for *claimed* names.
- **On-device status**: verified on a Nomad (2026-08-23) — `createNote`
  into `/storage/emulated/0/INBOX/` works, pages auto-append while the
  SwapNote is open, acks clear the server mailbox. The username-persistence
  gap still orphans offline pages across restarts (see limitations).

## v1 limitations

- Drawn strokes land on the *current* page only; there is no page-navigation
  API (confirmed upstream gap).
- Cleartext is blocked; the server must be HTTPS. Tailscale Serve is the
  documented path; any reverse proxy with a trusted cert works.
- Config persistence (username) is best-effort: the templates API works in
  the note context but the config store (settings context) still fails, and
  the config note path is relative — a fresh random username per restart
  means offline pages addressed to the old username are orphaned in the
  relay mailbox.
- Strokes drawn within ~1 s of an inserted echo are suppressed (loop guard).
- **Pull flashes the screen** (one full-page e-ink refresh per manual pull,
  however many strokes are queued). No SDK path to a partial/local redraw;
  `setTimeout`-based debouncing is unavailable in the runtime. The trade:
  remote strokes no longer appear live — the user pulls when convenient.
- Queued strokes are **in-memory only**: closing the note / restarting the
  plugin host drops the queue (they were never written to the note file).
  Queued *pages* are the same client-side, but un-acked pages survive a
  restart in the server's mailbox and are redelivered on reconnect (dedup
  keeps them from double-appending).
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
