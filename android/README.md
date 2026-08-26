# Ola Ink Android companion wrapper fixture

A small Android WebView APK for the Ola Ink architecture:

```text
development plugin -- Linking.sendIntent(com.olaink.OPEN_SHARE.dev, draftId) --> Ola Ink Dev
stable plugin ------ Linking.sendIntent(com.olaink.OPEN_SHARE, draftId) -----> Ola Ink
```

It is not the production client. It has no login or current-file access. It
persists a non-extractable WebCrypto P-256 private key in WebView IndexedDB.
After pairing, it resolves a recipient directory and encrypts a user-selected
whole note locally before uploading only its ciphertext.

The companion receives only an opaque, short-lived draft/launch ID. A complete
source `.note` must come from a user-mediated Storage Access Framework selection,
a supported `content://` read grant, or a reviewed native bridge. Never put a
file path, note bytes, authentication, or a direct note URL in an intent.

## Bundled Supernote plugin install

Each APK build first builds `packages/plugin` and embeds the resulting
`olainkplugin.snplg` as an APK asset. Debug embeds the development action
(`com.olaink.OPEN_SHARE.dev`); a signed release embeds the stable action
(`com.olaink.OPEN_SHARE`). Installing either bundle intentionally updates the
single, stable Supernote plugin ID to route future Share launches to that
companion. On the first-run screen, **Install
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
| `supernote-viewer.js` | `philips/supernote-obsidian-plugin` commit `f2f604445b8c3e4086ad1ebae11eeb1e5a4b553d` (autoplay-attribute branch, PR #252), with the animation paint cap patched from 30 to 10 FPS | `68ed212eab0e0252db9f7f4cc2e51bb06156708adae20d20c1299afd5efa6450` |

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
adb shell am start -n com.olaink.dev/com.olaink.MainActivity -a com.olaink.OPEN_SHARE.dev \
  --es draftId fixture-draft
android/scripts/verify-variant-apk.sh debug app/build/outputs/apk/debug/app-debug.apk
adb logcat -s OlainkPlayerProbe
```

The debug APK is `com.olaink.dev` (launcher label **Ola Ink Dev**) and uses a
local debug key. A stable `com.olaink` release must be built only after the
protected GitHub `release` environment has been configured as described in
[`../plans/android-apk-signing-and-dev-install.md`](../plans/android-apk-signing-and-dev-install.md).
For a local signing verification, provide the four `OLAINK_RELEASE_*`
environment variables accepted by Gradle, then run `./gradlew assembleRelease`.
It refuses to run when any signing input is absent. Verify its output with:

```sh
android/scripts/verify-variant-apk.sh release app/build/outputs/apk/release/app-release.apk
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --verbose --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

For a device test, run the server behind a development HTTPS endpoint (for
example Tailscale Serve), pair the companion from an authenticated browser
account, and create another account with a username. While editing a Supernote
note, tap **Ola Ink Share**: the companion opens its recipient screen. Enter
the recipient name, choose a `.note` no larger than 5 MiB through Android's
document picker, and press **Encrypt and send**. The recipient's paired inbox
should sync the note.

The activity logs received actions and PWA status. A `supernote-error` or
`Send failed` log is a failed device validation.

## Inbox

The companion top bar has an **Inbox** button. It syncs and displays notes
inside the companion WebView using the encryption key generated in that paired
profile. Pairing creates a random, device-scoped capability limited to
resolving recipients, sending from, polling, and acknowledging that same
device; it is not an AuthGravity account credential or an account-management
capability. The server stores only a SHA-256 digest of that capability.

Opening a note starts its write-on stroke replay immediately — the pinned
viewer's `autoplay="5x"` attribute opens the note blank and replays the
handwriting at 5× with no toolbar interaction. Its `scroll-behavior="instant"`
and `scroll-delay="1000"` settings prevent animated programmatic scrolling
and wait one second before a write-on replay changes pages, avoiding E-Ink
scrolling animations. **Settings → Disable note animation** (persisted in the WebView profile) switches to showing finished
pages immediately; the toolbar can still replay ink on demand. **Settings →
Log out** revokes the paired-device capability, removes the companion from the
account directory, and deletes its local inbox and encryption key. Pair it
again with a new code to continue.


The activity is `singleTop`, so a second launch reaches `onNewIntent`. Build
outputs and `.gradle/` are deliberately ignored.
