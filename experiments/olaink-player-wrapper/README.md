# OLAINK Android companion wrapper fixture

A small Android WebView APK that validates the two native building blocks for
the OLAINK architecture:

```text
Supernote Share plugin -- Linking.sendIntent(dev.olaink.OPEN_SHARE, draftId, notePath*) --> APK
                                                                                └─ WebView player

`*` `notePath` is an explicitly unsafe, Beta-only developer hand-off; it is
never part of the production protocol.
```

It is not the production client. It has no login or current-file access. It
persists a non-extractable WebCrypto P-256 private key in WebView IndexedDB and
can encrypt a selected full note to the server's development-only `echo`
recipient. Echo decrypts it and returns a newly encrypted record; the WebView
decrypts the reply and loads it in the pinned `<supernote-viewer>`.

The production wrapper receives an opaque, short-lived draft/launch ID. It
must obtain the complete source `.note` through a supported `content://` grant,
Storage Access Framework, or native companion bridge; never put a file path,
note bytes, authentication, or a direct note URL in a production intent.

For this Beta experiment only, `notePath` may be an absolute path returned by
`PluginCommAPI.getCurrentFilePath()`. The wrapper accepts only readable
`.note` files under `/storage/emulated/0/Note`, never exposes the path to
JavaScript/logcat, and streams it to its pinned WebView origin. Because a path
has no URI grant, the device developer must explicitly enable the companion's
all-files app-op. This is intentionally not a safe or shippable hand-off.

## Pinned viewer assets

The APK contains generated/test assets under `app/src/main/assets/`:

| asset | source | SHA-256 |
| --- | --- | --- |
| `supernote-viewer.js` | `philips/supernote-obsidian-plugin` commit `2d8948513367e655087d8073bcf14f1c1ce87f9e`, with the animation paint cap patched from 30 to 10 FPS | `946530af2a722460ac0f94488997870fe614591aa9b87d84cb6b201c8cc41867` |

`WebViewAssetLoader` maps APK assets to
`https://appassets.androidplatform.net/assets/`. This local HTTPS-looking
origin, rather than `file://`, is necessary for ES modules and workers.

Rebuild the pinned assets from a recursively cloned upstream checkout:

```sh
experiments/olaink-player-wrapper/scripts/update-pinned-viewer.sh \
  /path/to/supernote-obsidian-plugin
```

An upstream update must review the commit, paint-cap patch, checksum, and this
table together.

## Build and device test

Requires JDK 17, Android SDK Platform 35, and Build Tools 35.0.0:

```sh
cd experiments/olaink-player-wrapper
JAVA_HOME="$HOME/jdk17" ANDROID_HOME="$HOME/android-sdk" ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
# Beta direct-path experiment only; do not enable in a production build.
adb shell appops set dev.olaink.player MANAGE_EXTERNAL_STORAGE allow
adb shell am start -n dev.olaink.player/.MainActivity -a dev.olaink.OPEN_SHARE \
  --es draftId fixture-draft --es notePath /storage/emulated/0/Note/example.note
adb logcat -s OlainkPlayerProbe
```

To run the encrypted echo loop, start `npm run server` and expose its local
HTTP port through a development HTTPS endpoint (for example Tailscale Serve).
In companion Settings, enter that **HTTPS** URL, select a `.note` file, then
choose **Send selected full note to echo**. Expected status is
`Echo round-trip loaded …` in Settings; press the viewer's native **Play**
control to confirm replayed ink. The prototype endpoints are unauthenticated
and echo's private key is in the server process, so use fixtures only.

The activity logs the received action/extra and PWA status. A `supernote-error`
or `Prototype send failed` log is a failed device validation.

The activity is `singleTop`, so a second launch reaches `onNewIntent`. Build
outputs and `.gradle/` are deliberately ignored.
