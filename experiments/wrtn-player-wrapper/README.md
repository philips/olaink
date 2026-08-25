# WRTN Android companion wrapper fixture

A small Android WebView APK that validates the two native building blocks for
the WRTN architecture:

```text
Supernote Share plugin -- Linking.sendIntent(dev.wrtn.OPEN_SHARE, draftId) --> APK
                                                                     └─ WebView player
```

It is not the production client. It has no login, server session, encryption,
recipient, or current-file access. It loads a checked-in public fixture solely
to verify the pinned `<supernote-viewer>` in the Nomad System WebView.

The production wrapper receives an opaque, short-lived draft/launch ID. It
must obtain the complete source `.note` through a supported `content://` grant,
Storage Access Framework, or native companion bridge; never put a file path,
note bytes, authentication, or a direct note URL in an intent.

## Pinned viewer assets

The APK contains generated/test assets under `app/src/main/assets/`:

| asset | source | SHA-256 |
| --- | --- | --- |
| `supernote-viewer.js` | `philips/supernote-obsidian-plugin` commit `2d8948513367e655087d8073bcf14f1c1ce87f9e`, with the animation paint cap patched from 30 to 10 FPS | `946530af2a722460ac0f94488997870fe614591aa9b87d84cb6b201c8cc41867` |
| `fixture-write-on.note` | that commit's `supernote-typescript/tests/input/turkish-a6x-20230015-handwriting-erase.note` | `f3ef873f51a1c6e7c2ed14dabbc5461d610f845b93277396f8ebba31d4622136` |

`WebViewAssetLoader` maps APK assets to
`https://appassets.androidplatform.net/assets/`. This local HTTPS-looking
origin, rather than `file://`, is necessary for ES modules and workers.

Rebuild the pinned assets from a recursively cloned upstream checkout:

```sh
experiments/wrtn-player-wrapper/scripts/update-pinned-viewer.sh \
  /path/to/supernote-obsidian-plugin
```

An upstream update must review the commit, fixture, paint-cap patch, checksums,
and this table together.

## Build and device test

Requires JDK 17, Android SDK Platform 35, and Build Tools 35.0.0:

```sh
cd experiments/wrtn-player-wrapper
JAVA_HOME="$HOME/jdk17" ANDROID_HOME="$HOME/android-sdk" ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -a dev.wrtn.OPEN_SHARE --es draftId fixture-draft
adb logcat -s WrtnPlayerProbe
```

The activity logs the received action/extra. The local page reports
`capabilities` and `supernote-load` with `presentation: "write-on-paused"`.
Press the viewer's native **Play** control and confirm replayed ink appears.
`supernote-error` or `fixture-error` in logcat is a failed device validation.

The activity is `singleTop`, so a second launch reaches `onNewIntent`. Build
outputs and `.gradle/` are deliberately ignored.
