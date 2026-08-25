# AGENTS.md — olaink

End-to-end encrypted whole-`.note` exchange service. Primary surfaces are a
small **Supernote Share plugin** and a native Android **WebView wrapper around
the Ola Ink PWA**. TypeScript-first; Vitest for unit tests.

- `experiments/` — self-contained experiments, each its own project. The
  checked-in `olaink-player-wrapper` proves the PluginHost intent hand-off and
  the real Nomad System WebView player.
- `plans/` — architecture and research; issue 15 is the current architecture.
- `scripts/` — Supernote plugin ADB tooling.

## Device development (ADB over Wi-Fi)

The Nomad (Android 11, no root) is available over ADB/Tailscale:

```sh
adb connect 100.103.149.40:5555
scripts/snplg-deploy.sh packages/plugin
scripts/snplg-logs.sh
```

`snplg-deploy.sh` builds, pushes to `/storage/emulated/0/MyStyle/`, opens Plugin
Manager, drives installation, and waits for `PluginInstallManager: Install
Success`. Reinstalling the stable plugin ID upgrades in place.

Useful log tags: `ReactNativeJS` (plugin logs), `PluginApp` (view lifecycle),
`PluginManager`/`PluginContainerService` (host routing), and
`PluginInstallManager` (installation).

## Design constraints

- The plugin opens the companion; it does not authenticate, encrypt, poll,
  receive, extract strokes, or append notes.
- The PWA/WebView owns device keys in IndexedDB and encrypts/decrypts complete
  `.note` bytes. Do not introduce a plaintext page/stroke wire format.
- The current intent/WebView experiment proves activity launch and viewer
  playback, not a safe active-note binary hand-off. Do not pass note bytes,
  bearer tokens, authenticated URLs, or unscoped filesystem paths in intents.
  Use a supported `content://` grant or user-mediated/native source bridge.
- `closePluginView()` stops the plugin runtime. This is harmless now because
  delivery lives in the companion PWA, not a headless plugin process.
- The plugin runtime is unreadable from shell; use logcat for debugging.

## Conventions

- Keep the committed plugin ID stable.
- Keep Android experiment source/pinned assets, but never commit `build/` or
  `.gradle/` output.
- Official Supernote docs are canonical: <https://docs.supernote.com/en>.
  SDK typings are in `node_modules/sn-plugin-lib`.
- LLM features go through TPX: <https://tokenpony.dev/llms.txt>.
