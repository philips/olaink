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
`android/app/build/outputs/apk/debug/app-debug.apk`. `deploy:android` installs
onto the currently selected adb device; it does not establish the Wi-Fi adb
connection itself. The build requires JDK 17 plus Android SDK Platform and
Build Tools 35.
