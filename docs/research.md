# Research Notes

Findings from studying `sn-plugin-lib@0.1.43`, `@supernote-plugin/template@1.0.7`,
`apclark31/supernote-plugin-research` (incl. SuperTask plugin + CLAUDE.md of
on-device confirmed facts), and `guibor/supernote-endpoint-lasso` (proof of
plugin `fetch`). Local copies were studied in `/tmp/research/`.

## Plugin runtime & packaging

- Plugins are React Native apps: **RN 0.79.2 + React 19** (locked versions).
- Package format: `.snplg` = ZIP of `PluginConfig.json` + `<name>.bundle`
  (Hermes bytecode via `npx react-native bundle`) + icon + optional `app.npk`
  (native APK, only if native modules are used).
- **Pure-JS plugins skip gradle entirely** and build in under a minute
  (`buildPlugin.sh` from the template does bundle → zip → rename).
- `PluginConfig.json`: `pluginID` must be **16 alphanumeric chars and stable
  across builds** (upgrades key off it). The template's build script generates
  a random one each build — override it with a fixed ID. `pluginKey` must match
  the name registered with `AppRegistry`. Previous experiment used
  `wrtnbridge000001`.
- Install: copy `.snplg` to `/sdcard/MyStyle/`, then Settings → Apps → Plugins
  → Install. ADB push to MyStyle works on our device (see device.md).
- Architecture: plugin JS runs in a separate **PluginHost** process
  (`com.ratta.supernote.pluginhost`), talking to NOTE/DOC via AIDL.
- Plugin UI entry: `PluginManager.registerButton(type, appTypes, {...})` —
  type 1 = NOTE/DOC left toolbar (always visible), `showType: 1` = full-screen
  RN view, `showType: 0` = headless.
- `PluginManager.init()` must run **after** `AppRegistry.registerComponent`.

## Networking (the critical question)

- **`fetch` works on-device** — confirmed by two independent plugins
  (endpoint-lasso for HTTP POST w/ FormData + AbortController; SuperTask for
  Todoist REST + a local dev log server). This is our transport.
- **WebSocket is unverified** — no reference plugin uses it; RN's WebSocket
  needs the native `WebSocketModule`. Decision: **HTTP long-poll polling over
  `fetch` is the v1 transport** (guaranteed to work); the protocol is
  transport-agnostic so a WS adapter can be added after on-device validation.
- Hermes has **no WebAssembly** → avoid wasm-dependent libs.
- Android cannot resolve `.local` hostnames — use raw IPs (Tailscale IPs fine).

## Storage / config persistence

- `FileUtils` TurboModule has **no `writeFile`** (only exists/makeDir/copy/
  rename/delete/list/MD5). Native `FileUtils.java` has `saveTextToFile` but it
  is not bridged to JS.
- Proven write paths:
  1. **RNFS** (`react-native-fs@^2.20.0`, native module) → JSON at
     `/storage/emulated/0/MyStyle/<Plugin>/` (SuperTask pattern; survives
     plugin reinstall). Cost: gradle APK build (needs Android SDK 35).
  2. **`.note` file as storage** (pure SDK): `createNote` (with a *real*
     system template from `getNoteSystemTemplates()` — `'none'` fails with
     error 802) + `insertElements` type-500 text box carrying JSON + read back
     via `getElements`. Full round-trip confirmed by SuperTask research.
     Caveat: PluginFileAPI writes need a note context (error 102 from
     non-note screens) — our plugin launches from a note so this holds.
  3. `fetch('file:///...')` **read-only** (status is 0, not 200; `response
     .json()` still works) — usable for reading sidecar config.
- Decision: `KeyValueStore` interface with a **`.note`-file implementation**
  first (pure JS, fast builds), RNFS impl as fallback if flaky on-device.

## Reading strokes (send path)

- Register `PluginManager.registerEventListener('event_pen_up', registerType,
  listener)` — callback payload elements are **not directly readable**; call
  `PluginCommAPI.getLastElement()` to get the element with accessors.
- Alternative without events: poll/diff `PluginFileAPI.getElements(page,
  notePath)` or `getLastElement()`.
- Stroke data lives behind async `ElementDataAccessor`s:
  - `element.stroke.points.getRange(0, n)` → `Point {x,y}[]` (**EMR
    coordinates**, digitizer space; A6X2/Nomad max 15819×11864, axes rotated
    vs screen — use `PointUtils.emrPoint2Android(point, pageSize)` to convert)
  - `element.stroke.pressures` → `number[]`
  - `element.stroke.penColor` (0x00 black / 0x9D dk gray / 0xC9 lt gray /
    0xFE white), `penType` (10 fineliner / 1 pressure / 11 marker /
    14 calligraphy), `element.thickness`, `element.layerNum`, `numInPage`
- Context: `PluginCommAPI.getCurrentFilePath()` + `getCurrentPageNum()` +
  `PluginFileAPI.getPageSize(notePath, page)`.

## Writing strokes (receive path)

1. `PluginCommAPI.createElement(Element.TYPE_STROKE)` → native element with
   fresh uuid + accessors
2. Fill: `stroke.points.setRange(0, n-1, points)`, `pressures`, set
   `penColor`/`penType`/`thickness`/`layerNum`
3. `PluginFileAPI.insertElements(notePath, page, [element])`
4. `PluginNoteAPI.saveCurrentNote()` then `PluginCommAPI.reloadFile()` to see
   it on screen
5. `PluginCommAPI.recycleElement(uuid)` to free native memory

## Lifecycle / events

- `PluginManager.addPluginLifeListener({onStart, onStop})`
- `registerButtonListener({onButtonPress})` — fires when user taps our button;
  opens our full-screen view (`showType: 1`)
- `registerEventListener` only supports `event_pen_up` (priorities 0/1/2) and
  `motion_event`
- Palm contacts DO reach motion listeners while writing — don't over-trigger
  on touch events; pen_up is the reliable signal

## E-ink UI guidelines

- Black on white, no gradients/animations; large tap targets; typography +
  borders for hierarchy; minimize full refreshes.
- Typing on the e-ink keyboard is painful → auto-generate usernames, bundle
  server URL as build-time default (`config.local.js` pattern), allow
  USB-editable JSON config override.

## Debugging on-device

- No dev console; **logcat works on our device** (unusual — research repo's
  device blocked it) — but keep the SuperTask pattern anyway: local rotating
  log file + HTTP POST to a dev log server as backup observability.

## API locations cheat sheet

- `PluginCommAPI`: `getCurrentFilePath`, `getCurrentPageNum`, `createElement`,
  `getLastElement`, `recycleElement`, `reloadFile`, `getPenInfo`
- `PluginFileAPI`: `getElements`, `insertElements`, `getPageSize`,
  `createNote`, `getNoteSystemTemplates`, `getNoteTotalPageNum`
- `PluginNoteAPI`: `saveCurrentNote`, `insertText`
- `PluginManager`: `init`, `registerButton`, `registerEventListener`,
  `addPluginLifeListener`, `closePluginView`, `getPluginDirPath`,
  `getDeviceType` (Nomad = 4)
- `NativeUIUtils.showRattaDialog(tip, leftBtn, rightBtn, isSuccess)` — native
  dialog (works even headless)
- `FileUtils`: `exists`, `makeDir`, `listFiles`, `copyFile`, `renameToFile`

## Consequences for the WRTN design

1. Transport = HTTP JSON polling via `fetch`; server exposes simple REST +
   long-poll endpoints. Protocol messages are versioned JSON envelopes so a
   future WS transport is additive.
2. Plugin = pure JS (no native modules) for v1 → fast builds, no Android SDK
   dependency. Persistence via `.note` storage hack.
3. Username: generated on-device (short readable word form), persisted in the
   storage note, collision-checked against the server.
4. Echo user: server-side test oracle that joins any session and echoes
   strokes back **translated by an offset** so the round-trip is visually
   obvious on the note page.
5. Fixed `pluginID` (16 chars) in version control so reinstalls upgrade
   cleanly.
