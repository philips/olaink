# Supernote plugin research notes

## Runtime and packaging

- Plugins are React Native applications. A pure-JS plugin avoids a Gradle build.
- A `.snplg` contains `PluginConfig.json`, a Hermes bundle, and an icon.
- `pluginID` must remain a stable 16-character alphanumeric value so a new
  install upgrades the existing plugin.
- Call `PluginManager.init()` after `AppRegistry.registerComponent`.
- `showType: 1` opens a full-screen view; `showType: 0` runs headlessly.
- Plugin JS runs in the separate PluginHost process. Closing a displayed view
  stops that runtime, so SwapNote's headless toolbar button is the delivery
  entry point.

## Networking

- `fetch` works on-device. SwapNote uses HTTPS HTTP long polling because it is
  proven in the plugin runtime and keeps the protocol transport-agnostic.
- WebSocket support is unverified; Hermes has no WebAssembly.
- Android does not resolve `.local` names reliably. Use a Tailscale HTTPS name
  or address; PluginHost blocks cleartext HTTP.

## Note APIs used by SwapNote

- Read a page with `getCurrentFilePath`, `getCurrentPageNum`, and
  `PluginFileAPI.getElements`.
- Stroke point and pressure accessors are asynchronous. Points are EMR
  coordinates, not screen pixels.
- Create incoming elements with `createElement`, populate point/pressure
  ranges, and write with `insertElements`.
- Call `saveCurrentNote` and `reloadFile` after append; recycle native elements
  after failed writes.
- `createNote` needs a real system template. In settings context template
  lookup may fail, so `style_white` is the fallback.

## Persistence

`FileUtils` does not expose a write API to JavaScript. SwapNote persists its
server URL and generated username in a small absolute-path `.note` file under
MyStyle using a text element. This keeps the plugin pure JS and survives a
runtime restart.

## SwapNote coordinate conversion

Page-transfer messages normalize stroke points to `0..1` using sender EMR
size, and text bounds to `0..1` using sender page size. The receiver scales
strokes to its EMR size and text bounds to the inserted page size.

Verified device geometry:

| device | pixels | EMR |
| --- | --- | --- |
| A5X portrait | 1404×1872 | 15819×11864 |
| Nomad | 1920×2560 | 21632×16224 |

## Useful API locations

- `PluginCommAPI`: current file/page, create/recycle element, reload file
- `PluginFileAPI`: page elements, insertion, page size, note creation,
  templates, page count
- `PluginNoteAPI`: save current note
- `PluginManager`: toolbar registration, lifecycle, close view, device type
