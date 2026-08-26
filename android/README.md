# Ola Ink Android companion wrapper fixture

A small Android WebView APK for the Ola Ink architecture:

```text
Supernote Share plugin -- Linking.sendIntent(dev.olaink.OPEN_SHARE, draftId) --> APK
                                                                         └─ WebView player
```

It is not the production client. It has no login or current-file access. It
persists a non-extractable WebCrypto P-256 private key in WebView IndexedDB and
can encrypt a user-selected full note to the server's development-only `echo`
recipient. Echo decrypts it and returns a newly encrypted record; the WebView
decrypts the reply and loads it in the pinned `<supernote-viewer>`.

The companion receives only an opaque, short-lived draft/launch ID. A complete
source `.note` must come from a user-mediated Storage Access Framework selection,
a supported `content://` read grant, or a reviewed native bridge. Never put a
file path, note bytes, authentication, or a direct note URL in an intent.

## Bundled Supernote plugin install

Each APK build first builds `packages/plugin` and embeds the resulting
`olainkplugin.snplg` as an APK asset. On the first-run screen, **Install
Supernote plugin** writes that exact file to
`/storage/emulated/0/MyStyle/olainkplugin.snplg` and opens Supernote Plugin
Manager. The user then chooses that file and confirms **Install**; the
Supernote host has no supported API to bypass that final confirmation.

The fixed `MyStyle` destination does not ask for a folder, but Android 11
requires the user to grant Ola Ink's system **All files access** permission the
first time. This permission is used only to stage the plugin at the Supernote
storage location; it is not a note-source grant.

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
android/scripts/update-pinned-viewer.sh \
  /path/to/supernote-obsidian-plugin
```

An upstream update must review the commit, paint-cap patch, checksum, and this
table together.

## Build and device test

Requires JDK 17, Android SDK Platform 35, and Build Tools 35.0.0:

```sh
cd android
JAVA_HOME="$HOME/jdk17" ANDROID_HOME="$HOME/android-sdk" ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n dev.olaink.player/.MainActivity -a dev.olaink.OPEN_SHARE \
  --es draftId fixture-draft
adb logcat -s OlainkPlayerProbe
```

To run the encrypted echo loop, start `npm run server` and expose its local
HTTP port through a development HTTPS endpoint (for example Tailscale Serve).
In companion Settings, enter that **HTTPS** URL, select a `.note` file, then
choose **Send selected full note to echo**. Expected status is
`Echo round-trip loaded …` in Settings; press the viewer's native **Play**
control to confirm replayed ink. The prototype endpoints are unauthenticated
and echo's private key is in the server process, so use fixtures only.

The activity logs the received action and PWA status. A `supernote-error` or
`Prototype send failed` log is a failed device validation.

The activity is `singleTop`, so a second launch reaches `onNewIntent`. Build
outputs and `.gradle/` are deliberately ignored.
