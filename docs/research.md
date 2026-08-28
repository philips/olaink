# Supernote and companion research notes

## Plugin runtime

- Supernote plugins are React Native applications running in the separate
  PluginHost process. `closePluginView()` stops that runtime.
- The stable plugin ID must remain a 16-character alphanumeric value so an
  installation upgrades in place.
- `Linking.sendIntent()` from the real PluginHost successfully launched a
  companion fixture custom action with a scalar extra on the Nomad
  (2026-08-24). The retained fixture uses `com.olaink.OPEN_SHARE` and its
  `singleTop` activity receives later launches through `onNewIntent`.
- `Linking.sendIntent()` does not establish an explicit package or URI-grant
  permission. Use a unique action to avoid chooser ambiguity; do not treat the
  launch proof as proof of active-note byte sharing.

## Embedded native plugin package (Phase 0.1)

- On the Nomad (Android 11; PluginHost `1.00.2608211`, SDK reported as
  `0.1.65`), `experiments/embedded-plugin/olainkprobe.snplg` installed
  successfully on 2026-08-27. PluginHost copied its native archive to
  `files/plugins/olainknativeprobe1/app_<timestamp>.npk`, logged
  `getPackages packageName:com.olaink.probe.OlaInkProbePackage`, and
  constructed `OlaInkProbeModule`.
- Opening the registered NOTE plugin entry mounted the PluginHost full-screen
  React Native UI. The probe's `NativeModules.OlaInkProbe.describe()` call
  completed and displayed `com.ratta.supernote.pluginhost`; logcat recorded
  `OlaInkEmbeddedProbe: describe invoked`. This proves the narrow
  `.snplg` → `app.npk` → `reactPackages` load path used by SuperDashboard.
- The generated config declared `FILE:READ`, `FILE:WRITE`, and `INTERNET`.
  PluginHost logged them while initialising the plugin, but this probe did not
  call `hasPermission`/`requestPermission` or access a file/network. Do not
  interpret the install/load result as a permission grant or a direct-I/O
  validation.
- Phase 0.2 upgraded that same plugin ID from version code 1 to 2; the
  installer reported `isUpgrade=true`. Before user consent,
  `hasPermission(FILE:READ/FILE:WRITE/INTERNET)` returned `0`. Direct Java
  open of the active note and direct Java write under `Note` both threw
  `SecurityException`; direct HTTPS failed with `SocketException`. This
  confirms the documented scoped permission enforcement applies to the NPK
  native module rather than being bypassed by PluginHost's UID.
- Selecting **Allow This Time Only** (request result `1`) for each permission
  made the corresponding native operation succeed: one-byte bounded note open
  (no path/bytes returned), a 49-byte harmless Note-folder marker (removed via
  developer ADB), and an unauthenticated HTTPS `HEAD` to `app.olaink.com`
  (HTTP 404 still proves the connection completed). No note content, path, or
  account credential was logged or sent.
- On this firmware, `closePluginView()` followed by reopening the plugin left
  all three time-only grants at `1`. Force-stopping PluginHost then reopening
  reset all three to `0`. Treat “this time only” as lasting for the persistent
  PluginHost process, not merely while the full-screen view is hidden; do not
  rely on view close to revoke access.
- This result still says nothing about a WebView view manager,
  WebCrypto/IndexedDB, per-plugin key isolation, update authenticity, or
  persistence. Those remain explicit go/no-go gates in
  [`plans/embedded-native-snplg-feasibility.md`](../plans/embedded-native-snplg-feasibility.md).

## File boundary

The plugin SDK can obtain the current file/page and exposes page elements, but
it does not expose a binary `.note` read stream. Ola Ink no longer uses element
APIs for transfer. A production Share flow needs a supported `content://`
read grant, Storage Access Framework selection, or a reviewed native companion
bridge. A raw external-storage path, intent base64 payload, or filesystem copy
is not a secure/supported substitute.

## Companion WebView/player

- The Nomad System WebView is Chromium 109.
- The retained `android` uses
  `WebViewAssetLoader` to serve bundled assets at a local HTTPS origin. This is
  necessary for the viewer's ES modules/workers and avoids `file://`.
- The pinned `<supernote-viewer>` bundle and a real `.note` fixture load on the
  device with `presentation: 'write-on-paused'`; its native Play control
  successfully replays ink. The bundle's deliberate 10 FPS E-Ink paint cap,
  upstream revision, hashes, and update procedure are in `android/README.md`.
- The native wrapper should expose selected file bytes only to a pinned
  first-party PWA origin. WebView file/content access stays disabled, arbitrary
  navigation is blocked, and the JavaScript bridge is allowlisted.

## Networking and storage

The PluginHost `fetch` proof and Tailscale HTTPS setup remain useful only for
plugin deployment/configuration. Account sessions, device keys, encrypted
whole-note transport, polling, and playback are PWA/WebView responsibilities.
