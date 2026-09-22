# Ola Ink embedded native-plugin probe

This is the isolated **Phase 0.1–0.3** experiment from
[`plans/embedded-native-snplg-feasibility.md`](../../plans/embedded-native-snplg-feasibility.md).
It proves only the smallest claim suggested by SuperDashboard: a Supernote
`.snplg` can contain `app.npk`, declare a `ReactPackage` in
`PluginConfig.json`, and have PluginHost instantiate a native module from that
package.

It is not the Ola Ink product and must never be used to pair, encrypt a note,
or access an account/relay API. It contains no Ola Ink player asset or Android
Keystore use. Phase 0.2 makes one unauthenticated HTTPS `HEAD` request and has
deliberately bounded direct file probes; neither returns or logs note bytes or
a note path. Phase 0.3 contains a WebView probe solely to reproduce the
platform prohibition described below.

## Archive contents

```text
olainkprobe.snplg
├── olainkprobe.bundle
├── PluginConfig.json
├── icon.png
└── app.npk
    └── com.olaink.probe.OlaInkProbePackage
        └── OlaInkProbeModule.describe()
```

`app.npk` is an APK-shaped code/resource container dynamically loaded by
PluginHost. It is **not** an independently installed app: its manifest has no
activity or Android permission and it must not be installed with `adb install`.
The `reactPackages` and `nativeCodePackage` fields are the relevant contract.

The archive declares the three eventual Ola Ink permissions so Phase 0 can
inspect and exercise their enforcement. Its direct I/O controls are a distinct,
non-production go/no-go probe—not a source bridge design.

## Build

The experiment deliberately reuses the repository's plugin dependencies, so
install them first at the repository root:

```sh
npm ci
bash experiments/embedded-plugin/buildPlugin.sh
```

The build requires JDK 17, Android SDK Platform/Build Tools 35, `zip`, `unzip`,
and the repository root `node_modules`. `JAVA_HOME` and `ANDROID_HOME` default
to `$HOME/jdk17` and `$HOME/android-sdk`; override them when needed.

The build runs `verifyArchive.sh`, which checks the generated config, archive
members, `classes*.dex`, and `OlaInkProbePackage`. A passing archive check is
not a device-runtime result.

## Nomad procedure and expected result

```sh
adb connect 100.103.149.40:5555
scripts/snplg-deploy.sh experiments/embedded-plugin
adb logcat -c
# In a NOTE: open the plugin toolbar, tap “Ola Ink native probe”.
# Run the native-module check, inspect permission state, and grant a test
# permission only when intentionally testing its corresponding control.
adb logcat -d -s ReactNativeJS:V OlaInkEmbeddedProbe:V PluginApp:V PluginHost:V
```

The screen must show an `OK r3: com.ratta.supernote.pluginhost; ...` line.
Logcat must contain `OlaInkProbeModule constructed revision=3` and `describe
invoked revision=3` under `OlaInkEmbeddedProbe`. `NativeModules.OlaInkProbe is
unavailable`, a `ClassNotFoundException`, or no toolbar button is a failure;
capture the full PluginHost/PluginInstallManager log and do not proceed to
WebView or key work.

### Phase 0.2 controls and Nomad result

- With every `hasPermission` result at `0`, **Open current NOTE in native
  Java** and **Write harmless Note-folder marker** failed with
  `SecurityException`; native HTTPS failed before Internet consent.
- Selecting **Allow This Time Only** and confirming the PluginHost dialog made
  each matching probe succeed. The write control creates only
  `ola-ink-probe-permission.txt`; remove it through developer ADB immediately:

  ```sh
  adb -s 100.103.149.40:5555 shell rm -f \
    /storage/emulated/0/Note/ola-ink-probe-permission.txt
  ```

- On Nomad, a plugin view close/reopen retained these time-only grants while
  the persistent PluginHost process lived. `adb shell am force-stop
  com.ratta.supernote.pluginhost` cleared them. This is observed behavior, not
  a substitute for a product permission UX.
- Version code 2 installed as an in-place upgrade of version code 1. It does
  not establish persistence of future WebView/key state.

### Phase 0.3 WebView result — no-go

Version code 3 packages static local HTML/module/worker assets and registers a
minimal native WebView view manager. Mounting it on Nomad fails before any
asset is loaded with Android's:

```text
UnsupportedOperationException: For security reasons, WebView is not allowed in privileged processes
```

The stack begins in `WebViewFactory.getProvider`; PluginHost closes the plugin
view. PluginHost is UID 1000 on this device. Do not try to work around this
with a different local origin, asset loader, bridge, or WebView setting: none
runs before the provider check. This is the decisive no-go for moving Ola
Ink's current PWA/WebCrypto/IndexedDB/viewer endpoint into `.snplg`.

Keep the separate signed APK. The remaining theoretical key/update-isolation
questions do not justify a new native-only encrypted client merely to combine
installation artifacts.
