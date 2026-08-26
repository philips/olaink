## Supernote: adb over Wi-Fi

The device firmware exposes no adb-over-Wi-Fi switch in the Supernote
Settings app, but it's stock Android 11 underneath — the real Android
Settings are reachable, and its "adb over WiFi" option is **persistent**
(fixed port **5555**, survives reboots).

One-time setup (needs USB once, with USB debugging already enabled — the
Supernote has its own ADB toggle behind a user agreement in Settings):

1. `adb shell am start -a android.settings.SETTINGS`
   — opens the **real Android settings** page
2. **About tablet** → tap **Build number** 10× (unlocks Developer options)
3. **System → Advanced → Developer options** → enable **adb over WiFi**
4. If the connection won't establish, toggle **USB debugging** off and on
5. Unplug USB, then on the dev machine:

   ```sh
   adb connect <device-ip>:5555
   ```

   The device IP can be the LAN address or its Tailscale address
   (e.g. `100.103.149.40:5555`).

### Recovery: `Connection refused` on port 5555

If the Supernote is reachable on the network but `adb connect <device-ip>:5555`
reports `Connection refused`, reconnect it over USB and force the currently
running `adbd` into TCP mode before unplugging:

```sh
adb tcpip 5555
adb connect <device-ip>:5555
```

This is a recovery step for a device whose persistent **adb over WiFi** setting
did not start the listener. It requires an already-authorized USB ADB session;
repeat it after a reboot if the listener is again absent.

Fallback (older path, still works): over USB run
`adb shell settings put global adb_wifi_enabled 1`, accept the popup —
but that path uses a **random port that changes on every enable**, so you
have to port-scan the device each time (e.g.
`masscan -p1-65535 <ip> --rate=1000 -e wlan0`). Prefer the persistent
port-5555 path above.

Context: the Supernote's USB connection is flaky for many users (not
recognized, driver fails, adb drops after seconds) — Wi-Fi adb is the
stable debug link. See [r/Supernote: enabling adb over wifi](https://www.reddit.com/r/Supernote/comments/1ifxw9h/enabling_adb_over_wifi/).

With adb connected, see `AGENTS.md` for the plugin dev loop
(`scripts/snplg-deploy.sh`, `scripts/snplg-logs.sh`).


The architecture and migration plan are in
[`plans/issue-15-e2ee-note-service.md`](plans/issue-15-e2ee-note-service.md).
The validated Nomad intent/WebView fixture is
[`android`](android).

## Layout

```
packages/
  plugin/     Supernote Share plugin
  server/     encrypted whole-note storage and pairing service
android/       native Android WebView/player hand-off fixture
plans/         architecture and device research
scripts/      Supernote plugin ADB helpers
```

## Development

```sh
npm install
npm test
npm run typecheck

# Current plugin development loop
adb connect 100.103.149.40:5555
npm run deploy:plugin
npm run logs
```

## Ola Ink Android companion APK

The repository-root npm targets build and install the debug companion APK:

```sh
# The npm targets default to these paths. Export different JDK 17 / SDK paths
# only when yours are elsewhere.
export JAVA_HOME="$HOME/jdk17"
export ANDROID_HOME="$HOME/android-sdk"
adb connect 100.103.149.40:5555  # or your configured device

npm run build:android            # produces the APK only
npm run deploy:android           # builds, then adb install -r
```

`build:android` defaults `JAVA_HOME` to `$HOME/jdk17` and `ANDROID_HOME` to
`$HOME/android-sdk` when they are unset, avoiding an incompatible system JDK.
The APK is written to
`android/app/build/outputs/apk/debug/app-debug.apk`. It is the independently
installable `com.olaink.dev` package, labelled **Ola Ink Dev**, and its bundled
Supernote plugin routes Share launches with `com.olaink.OPEN_SHARE.dev`.
`deploy:android` installs onto the currently selected adb device; it does not
establish the Wi-Fi adb connection itself. The build requires JDK 17 plus
Android SDK Platform and Build Tools 35.

The public stable app is separately signed as `com.olaink` and uses
`com.olaink.OPEN_SHARE`. It is only built from a tag in the protected GitHub
`release` environment; do not use a local debug APK as its substitute. See
[`plans/android-apk-signing-and-dev-install.md`](plans/android-apk-signing-and-dev-install.md)
for signing setup, release verification, and commands to launch both variants.

## Pinned `supernote-viewer.js` web component

The `<supernote-viewer>` web component used by the Android companion
(`player.html`) and the server's browser inbox is **not** vendored from source
here. A built bundle from the upstream `philips/supernote-obsidian-plugin`
repo is pinned as a checked-in asset:

- `android/app/src/main/assets/supernote-viewer.js` — the pinned bundle
  (also served by the APK's `WebViewAssetLoader` and, via the embed step,
  re-exported as `packages/server/src/viewerAsset.ts`)
- `android/scripts/update-pinned-viewer.sh` — records the pinned upstream
  commit and SHA-256 checksum, and rebuilds the asset
- `android/README.md` — the pin table (commit, patch, checksum)

The pin currently points at upstream commit `f2f6044` (the
`feat/webcomponent-autoplay` branch, PR #252) and carries one local patch: the
stroke-animation paint cap is sed-edited from 30 to 10 FPS so the Nomad's
E-Ink panel is not asked to refresh faster than it can show. The companion
sets the bundle's `scroll-behavior="instant"` and `scroll-delay="1000"`
attributes to avoid E-Ink scrolling animations during write-on playback. The script fails
if the minified FPS constant it expects is no longer present, so an upstream
rebuild that changes it can never be applied silently.

### Updating the pin

From a recursive clone of upstream at the new commit:

```sh
android/scripts/update-pinned-viewer.sh /path/to/supernote-obsidian-plugin
```

The script builds upstream's `supernote-typescript` submodule, runs
`npm run build:webcomponent`, verifies and applies the 10 FPS patch, copies
the bundle into the APK assets, and checks it against `VIEWER_SHA256`. An
update is a deliberate, reviewable change: the commit, the patch behavior, the
checksum, and the README pin table must be reviewed together. Bump both
`UPSTREAM_COMMIT` and `VIEWER_SHA256` in the script (compute the new checksum
with `sha256sum` after patching) and update the table in `android/README.md`.

Because the browser inbox embeds the same asset, the server's copy must be
refreshed too. This is automated: `npm test` regenerates the embedded files
before running (a `pretest` hook), CI rejects stale ones
(`npm run check:generated`), and `npm run build:server[:arm64]` regenerates
before compiling. After a pin update, reinstall the APK so both surfaces
serve the same bundle:

```sh
npm run deploy:android
```

The compiled server binary also bakes the deploy commit in at build time
(`scripts/build-server.mjs` passes it to `bun --define`; there is no committed
`buildInfo.ts` value to keep stashing).

Features are validated upstream before pinning: run upstream's own suite
(`npx vitest run src/webcomponent/SupernoteViewerElement.test.ts`) against a
checkout of the pinned commit. Host integration notes for the component
itself (e.g. the `autoplay` attribute's strict `<num>x` format and its
interaction with the `presentation` property) live in upstream's
`webcomponent-usage.md`.
