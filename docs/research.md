# Supernote and companion research notes

## Plugin runtime

- Supernote plugins are React Native applications running in the separate
  PluginHost process. `closePluginView()` closes the plugin view, while the
  PluginHost process itself is persistent; the Phase 0 permission experiment
  shows a time-only permission can remain until that process exits.
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
- Phase 0.3 is a decisive failure for the combined-client proposal. The
  registered native WebView view manager threw
  `UnsupportedOperationException: For security reasons, WebView is not allowed
  in privileged processes` from `WebViewFactory.getProvider` when it called
  `new WebView(...)`; PluginHost closed the plugin view. `dumpsys activity`
  identifies PluginHost as UID 1000. The failure occurs before local asset
  serving, so a different origin, `WebViewClient`, or JavaScript bridge cannot
  change it. The plugin cannot host Ola Ink's PWA, WebCrypto/IndexedDB keys, or
  pinned WebView viewer. Keep the separate signed APK; see the no-go decision
  in [`plans/embedded-native-snplg-feasibility.md`](../plans/embedded-native-snplg-feasibility.md).
  The disposable `olainkprobe` was uninstalled from Nomad after this test; its
  data was deleted by Plugin Manager.

## Single-plugin native client experiment (E0)

- [`plans/single-snplg-native-client-experiment.md`](../plans/single-snplg-native-client-experiment.md)
  tracks the non-WebView off-ramp experiment replacing the APK+plugin pair.
  E0 (`experiments/native-client-plugin/`, throwaway ID `olainknativeexp1`)
  passed on 2026-08-29: one five-member `.snplg` loads the `OlaInkNativeClient`
  module and `OlaInkSvgDocument` Canvas view from a pure-Java `app.npk`
  (no `.so`, so no duplicate RN/Hermes libraries).
- Same-ID upgrade from version 1 to 2 installed as `isUpgrade=true` and the
  reopened UI showed only revision-2 markers. PluginHost logged
  `resolveNativeLibsPath npkFileName:app_<ts>.npk, libsDirName:app_<ts>_libs`
  while upgrading, revealing that each NPK gets a timestamped libs directory —
  relevant input for E1's durable per-plugin state-directory discovery.
- The E0 archive verifier rejects Ola Ink WebView/browser references in bundle
  and dex. A generic `android.webkit.WebView` string check is not usable:
  React Android's transitive AndroidX `LinkifyCompat` references the static
  platform `WebView.findAddress` helper without ever constructing a WebView.

## Single-plugin native client experiment (E1)

- E1 crypto interop passed on 2026-08-29. `NoteV1.java` (pure JCA) is
  byte-compatible with the production WebCrypto wire format: host-JVM tests
  and the on-device self-test reproduce a committed WebCrypto record
  byte-for-byte, decrypt real-random WebCrypto records, and reject tampering.
  Committed vectors live in
  `experiments/native-client-plugin/vectors/note-v1-vectors.json`.
- Android Keystore ECDH is unavailable on this Android 11 firmware
  (`PURPOSE_AGREE_KEY`/KeyAgreement all fail), so the identity must stay a
  software key wrapped by an AndroidKeyStore AES-GCM key. That key must be
  created with `setRandomizedEncryptionRequired(false)` or every wrap fails
  with `Caller-provided IV not permitted`.
- Durable state discovery: both `filesDir/plugins/<id>/…` and a custom
  `filesDir/olaink-e1-<id>/` sibling survive same-ID upgrades and PluginHost
  force-stop, and internal `filesDir` writes need no PluginHost permission.
  PluginHost accepted same-versionCode archives with modified content as
  upgrades (`isUpgrade=true`) — no install-time content authenticity was
  observed.
- PluginHost closes the entire plugin view when a native-module method throws
  on the RN bridge thread (e.g. `ObjectAlreadyConsumedException` from logging a
  consumed `WritableArray`). Native modules must never throw; bridge values
  must be stringified before resolution.
- The Nomad dropped off the network after an `adb reboot` (Tailscale client
  did not rejoin without on-device interaction). Once it returned, the queued
  E1 device items completed:
  - reboot persistence holds for both state dirs and the TEE-backed keystore
    wrapping key;
  - the hostile probe `olainkhostile001` (no permissions declared) proved the
    isolation boundary: reads under `files/plugins/<other-id>/` fail with
    `AccessDeniedException` (the SDK's `PluginCheck` enforces per-plugin path
    access), but custom sibling dirs under `filesDir` are fully readable by
    other plugins, and the Android Keystore has **no** per-plugin isolation —
    a hostile plugin decrypted and then deleted the victim plugin's
    keystore-wrapped identity alias;
  - downgrades are rejected (`errorCode=103, "Plugin Version is low"`), but
    uninstall leaves `files/plugins/<id>/` state and the install DB row intact
    (reinstall after uninstall reports `isUpgrade=true`, so downgrade
    protection spans uninstall/reinstall) — logout must clean state itself;
  - a logout-style clear removed all sentinels, the wrapped identity, and the
    keystore alias.

## Single-plugin native client experiment (E2)

- E2 core relay transport passed on 2026-09-21 with the disposable
  `olainknativeexp1` v4 archive. Its `RelayClient` accepts only one build-time
  fixed HTTPS staging IP/port and a pinned leaf SHA-256 certificate; it has
  10-second connect/read limits, no redirects, a 1 MiB response cap, and
  redacted errors. No WebView, WebCrypto, or APK participates.
- An independent Node WebCrypto peer paired with Java/JCA identity
  `device_e2_ek1thlje`. Plugin → peer delivered and peer decrypted/ACKed a
  4,096-byte encrypted fixture; peer → plugin delivered an 8,192-byte fixture
  which the plugin decrypted, persisted as ciphertext in its plugin-tree
  profile, then ACKed. After PluginHost force-stop and NOTE-sidebar reopen,
  the same paired device and two stored records remained. The next poll was
  empty, confirming ACK idempotence.
- A relay-shaped record with one flipped AES-GCM ciphertext bit produced
  `polled=1, acked=0, failed=1` on two consecutive plugin polls. The native
  log exposed only its record ID and `ProtocolException`; it never ACKed the
  bad record. A stopped relay yielded a recoverable redacted HTTP 502, an
  invalid one-use code yielded HTTP 400, and server-confirmed logout removed
  the local profile (status then reported no identity, pairing, or inbox).
- This is functional research only. E1's shared-UID Keystore/update failures
  remain a decisive production replacement no-go. Direct revoked-token,
  timeout, malformed relay response, stale-directory, cancellation, and
  interrupted-atomic-write cases remain for E4/E5. The staging DB had no
  fixture plaintext marker; its TLS keys, peer state, logs, PIDs, and SQLite
  output are ignored and archive verification rejects credentials/state.

## Single-plugin native client experiment (E3)

- E3's provenance gate cleared on 2026-09-21. The original author
  retroactively relicensed the project in
  `27ea9bf7336df4929224b413132f4406144ae39d`; that commit is already an
  ancestor of pinned PR 119 commit `71464862838eefad14da02da2c3694421578cd48`,
  whose `LICENSE` is Apache-2.0. No rebase is needed. The old
  `package.json` still reports `GPL-3.0-or-later`, so `converter-lock.json`
  records both the effective Apache license and relicensing commit; preserve
  upstream LICENSE/provenance with any bundled converter.
- The first bundle is now a SHA-256-pinned 1.7 MiB browser/CJS artifact
  exporting only `SupernoteX` and `toSvg`; it is 657,032 bytes gzip. The E3
  archive includes the upstream Apache LICENSE/provenance and one public,
  82,615-byte ruler-tool `.note` fixture. Native code returns it only as six
  capped 16 KiB base64url chunks; the Node smoke produced three v1 scene SVGs
  (two with stroke metadata) without persisting SVG output. On Nomad, Hermes
  lacks `Intl.ListFormat`, `Intl.Collator`, `TextDecoder`, and `TextEncoder`;
  upstream named-capture `match.groups` is also undefined, so a recorded
  positional-capture patch and narrow shims were necessary just to start.
  Conversion then remained running for over 70 seconds and reached 312 MiB
  native PSS / 355 MiB native heap allocation for the 82 KiB fixture.
  Force-stopping PluginHost recovered it. This browser/image-js bundle path is
  an E3 memory/latency failure; do not use it in E4. The E1 PluginHost
  isolation failure remains independent and still prohibits replacing the APK.

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
  upstream revision, hashes, and update procedure are now in
  `packages/server/README.md` (the companion wrapper was retired).
- The native wrapper should expose selected file bytes only to a pinned
  first-party PWA origin. WebView file/content access stays disabled, arbitrary
  navigation is blocked, and the JavaScript bridge is allowlisted.

## Networking and storage

The PluginHost `fetch` proof and Tailscale HTTPS setup remain useful only for
plugin deployment/configuration. Account sessions, device keys, encrypted
whole-note transport, polling, and playback are PWA/WebView responsibilities.
