# AGENTS.md — olaink

End-to-end encrypted whole-`.note` exchange service. The production Supernote
surface is a single self-contained **`.snplg` plugin** (React screens: Inbox /
Send / Settings; an NPK Java package for device keys, record crypto, bounded
`.note` read/write, and the encrypted UI journal). There is no APK companion,
no WebView, and no SVG conversion. TypeScript-first; Vitest for unit tests.

- `packages/plugin/` — the plugin: React UI + NPK (`packages/plugin/android/`)
  + `buildPlugin.sh` / `verifySnplg.sh`.
- `packages/server/` — the relay (`app.olaink.com`): ciphertext-only routing,
  pairing, and the browser inbox. The pinned `supernote-viewer.js` asset and
  its update script live here too.
- `plans/` — architecture and research; issue 15 is the current architecture.
- `scripts/` — Supernote plugin ADB tooling.
- `snuxlib/` — the shared Supernote plugin UX kit (tab menu, rows, buttons,
  toggle, confirm panel, Logs tab, demo, docs). Ola Ink's UI is built on it and
  the Readwise plugin vendors it. **Build or change plugin UI there, not by
  hand-rolling components in a plugin**; start at `snuxlib/README.md`.

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

- The plugin is self-contained: React owns the foreground HTTPS transport to
  the relay; NPK owns device keys, record-v1 encryption/decryption, bounded
  `.note` I/O, and the encrypted journal. Do not reintroduce a plaintext
  page/stroke wire format — exchange is whole `.note` files only.
- The relay stores ciphertext only. It never receives strokes, text,
  plaintext filenames, or content keys.
- Received notes save under `Note/OlaInk/` and open in Supernote Notes via the
  host `openFile` API.
- `closePluginView()` stops the plugin runtime. Polling is foreground-only by
  design; undelivered records simply stay on the relay until the next poll.
- The plugin runtime is unreadable from shell; use logcat for debugging.

## Conventions

- Plugin UI uses `snuxlib` (workspace package `snuxlib`). After changing it, check
  the Ola Ink screens on the Nomad, and re-vendor into other plugins with
  `snuxlib/scripts/vendor.sh` (see its README).
- Keep the committed plugin ID stable (`olainksync00000001`) and `pluginKey`
  (`olaink`). `versionCode` must stay monotonically increasing; releases use
  the git-count scheme (see `plans/release-snplg-workflow.md`).
- Keep NPK source and pinned assets, but never commit `build/` or `.gradle/`
  output.
- Official Supernote docs are canonical: <https://docs.supernote.com/en>.
  SDK typings are in `node_modules/sn-plugin-lib`.
- LLM features go through TPX: <https://tokenpony.dev/llms.txt>.
