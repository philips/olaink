# Supernote and companion research notes

## Plugin runtime

- Supernote plugins are React Native applications running in the separate
  PluginHost process. `closePluginView()` stops that runtime.
- The stable plugin ID must remain a 16-character alphanumeric value so an
  installation upgrades in place.
- `Linking.sendIntent()` from the real PluginHost successfully launched a
  companion fixture custom action with a scalar extra on the Nomad
  (2026-08-24). The retained fixture uses `dev.olaink.OPEN_SHARE` and its
  `singleTop` activity receives later launches through `onNewIntent`.
- `Linking.sendIntent()` does not establish an explicit package or URI-grant
  permission. Use a unique action to avoid chooser ambiguity; do not treat the
  launch proof as proof of active-note byte sharing.

## File boundary

The plugin SDK can obtain the current file/page and exposes page elements, but
it does not expose a binary `.note` read stream. Ola Ink no longer uses element
APIs for transfer. A production Share flow needs a supported `content://`
read grant, Storage Access Framework selection, or a reviewed native companion
bridge. A raw external-storage path, intent base64 payload, or filesystem copy
is not a secure/supported substitute.

## Companion WebView/player

- The Nomad System WebView is Chromium 109.
- The retained `experiments/olaink-player-wrapper` uses
  `WebViewAssetLoader` to serve bundled assets at a local HTTPS origin. This is
  necessary for the viewer's ES modules/workers and avoids `file://`.
- The pinned `<supernote-viewer>` bundle and a real `.note` fixture load on the
  device with `presentation: 'write-on-paused'`; its native Play control
  successfully replays ink. The bundle's deliberate 10 FPS E-Ink paint cap,
  upstream revision, hashes, and update procedure are in the experiment README.
- The native wrapper should expose selected file bytes only to a pinned
  first-party PWA origin. WebView file/content access stays disabled, arbitrary
  navigation is blocked, and the JavaScript bridge is allowlisted.

## Networking and storage

The PluginHost `fetch` proof and Tailscale HTTPS setup remain useful only for
plugin deployment/configuration. Account sessions, device keys, encrypted
whole-note transport, polling, and playback are PWA/WebView responsibilities.
