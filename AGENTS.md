# AGENTS.md — wrtn

Handwritten-message exchange service. Primary surfaces: a **Supernote plugin**
and a scanner PWA. TypeScript-first, vitest for unit tests.

- `experiments/` — self-contained experiments, each its own npm project:
- `plans/` — design notes and research logs (`supernote-plugin.md` is the main one)
- `scripts/` — cross-experiment device tooling (adb deploy/logs, see below)

## Device dev loop (adb over Wi-Fi)

The Supernote (Nomad, Android 11, no root) is reachable over adb/Tailscale.
Setup is documented in `README.md` ("Supernote: adb over Wi-Fi"). Daily loop:

```sh
adb connect 100.103.149.40:5555          # or SNPLG_DEVICE=... for another device

scripts/snplg-deploy.sh                 # build stroke-live, push, auto-install
scripts/snplg-deploy.sh experiments/snplg-bridge
scripts/snplg-deploy.sh --no-build      # just push+install an existing build

scripts/snplg-logs.sh                   # live tail of plugin host + JS logs
scripts/snplg-logs.sh --capture --quiet # one-shot recent buffer, noise filtered
```

`snplg-deploy.sh` automates the whole install: `adb push` to
`/storage/emulated/0/MyStyle/`, deep-link
`com.ratta.settings/.SettingsActivity -a com.ratta.settings.application.PluginManagerFragment`,
then drives the UI with `uiautomator dump` + `input tap`
(Add Plugin → file → Install) and waits for
`PluginInstallManager: Install Success` in logcat. Reinstalling the same
`pluginID` is an in-place upgrade (no uninstall).

Log tags that matter (`snplg-logs.sh` filters to these):

| tag | what |
| --- | --- |
| `ReactNativeJS` | the plugin's `console.log` + SDK `verifyParams` noise |
| `PluginApp` | view show/hide, `closePluginView`, `stopPlugin` |
| `PluginManager` / `PluginContainerService` | host lifecycle, client routing |
| `PluginInstallManager` | install/upgrade + `Install Success` |

Device facts that shaped the design (verified 2026-08-21):

- no root; plugin runtime lives in
  `/data/user/0/com.ratta.supernote.pluginhost/files/plugins/<pluginID>/`
  (read-only from shell) — so all debugging is logcat-based
- `closePluginView()` detaches the view **and the host calls stopPlugin** —
  the JS runtime does not survive view close; long-running streams need a
  `showType: 0` headless button
- stroke point data is stored in **EMR coordinates**, not pixels — convert
  with `PointUtils.androidPoint2Emr`-equivalent math before `setRange`
  (A5X portrait 1404×1872 → EMR 15819×11864; Nomad 1920×2560 → 21632×16224)

## Conventions

- Stable committed `pluginID` (never random) — reinstall = upgrade, not new plugin
- Normalized `0..1` stroke coordinates on the wire; device does the geometry
- Official docs are canonical: https://docs.supernote.com/en (index at
  `/llms.txt`); community SDK research:
  https://github.com/apclark31/supernote-plugin-research
- SDK typings: `node_modules/sn-plugin-lib` (successor to the unpublished
  `rtn-supernote-plugin-core`)
- LLM features go through TPX (https://tokenpony.dev/llms.txt)
