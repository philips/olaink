# Device Notes

Target device, verified 2026-08-21 via `adb connect 100.103.149.40:5555`
(Tailscale CGNAT IP — server on this host is reachable from the tablet).

## Device

| Item | Value |
|---|---|
| Model | Supernote Nomad (A6X2, machine type 4) |
| Android | 11 |
| Firmware | Chauvet.E103.2606161001.2393_release |
| ADB serial | 100.103.149.40:5555 (already paired/trusted) |

## ADB capabilities (all verified working)

- `adb connect` / `adb devices` ✓
- `adb shell` ✓ (full shell, unlike apclark31's locked-down unit)
- `adb push`/`pull` to `/sdcard` ✓
- `adb logcat` ✓
- `run-as com.ratta.supernote.pluginhost` ✗ (not debuggable; plugin data dir
  not readable)

Note: the upstream research repo reports ADB locked down on their device
("error: not support command" for shell/push). Our unit is unrestricted —
do not assume this generalizes.

## On-device state

- `/sdcard/MyStyle/` contains `StrokeLive.snplg` and `OlainkBridge.snplg` —
  leftovers from the abandoned `experiments/snplg-bridge` (see .gitignore).
  `OlainkBridge.snplg` PluginConfig: pluginID `olainkbridge000001`,
  reactPackages `["com.olainkbridge.olainkcore.OlainkCorePackage"]`,
  nativeCodePackage `/app.npk`.
- PluginHost package: `com.ratta.supernote.pluginhost` versionName
  1.00.26005190. No exported install intents found → install is manual:
  push `.snplg` to `/sdcard/MyStyle/`, then on-device Settings → Apps →
  Plugins → Install.

## Install / test loop

```sh
adb connect 100.103.149.40:5555
adb -s 100.103.149.40:5555 push build/outputs/<Name>.snplg /sdcard/MyStyle/
# on device: Settings → Apps → Plugins → Install (reinstall for upgrades)
adb -s 100.103.149.40:5555 logcat --pid=$(adb shell pidof -s com.ratta.supernote.pluginhost)
```

## Open device questions

The production plugin is self-contained: it owns the device key, reads the
active whole `.note`, and encrypts/decrypts in-process. The earlier
"hand the active note to a separate companion app" question is therefore
moot — there is no cross-process note hand-off to design around.

- If a future feature needs a note the plugin did not open, the remaining
  question is whether Supernote will expose a supported `content://` read
  grant or Storage Access Flow that yields precisely the active full
  `.note` without broad storage access.
