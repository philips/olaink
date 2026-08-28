# Feasibility plan: ship Ola Ink as one native `.snplg`

## Decision

**No-go for Ola Ink's current architecture. Keep the separately signed APK.**
A single installable `.snplg` can load a native `app.npk`, but on the supported
Nomad Android forbids constructing `WebView` inside the privileged PluginHost
process. The current endpoint deliberately depends on a local PWA/WebView for
WebCrypto keys, IndexedDB, whole-note encryption/decryption, and viewer
playback; that endpoint cannot be moved into the plugin as designed.

A future `.snplg` product would require a reviewed replacement for the complete
PWA/WebView endpoint (crypto/key storage, persistence, encrypted record UI,
and note playback) using only PluginHost-compatible React Native/native APIs.
That is a new client with a materially weaker/unproven same-UID trust boundary,
not a deployment refactor. It must not be pursued as an installation shortcut.

The useful result is limited: a plugin can carry small native helpers, but it
cannot replace the current companion. Keep the APK's launcher, app UID, signed
update channel, WebView profile, and background-capable user entry point. The
APK may continue to bundle the matching `.snplg`; Plugin Manager's explicit
final confirmation remains the supported host flow.

## What SuperDashboard demonstrates

Research was performed against
[`AgP42/SuperDashboard` commit `73b3f1fc4e5b0540df0fa3355abe5187ad617233`](https://github.com/AgP42/SuperDashboard/tree/73b3f1fc4e5b0540df0fa3355abe5187ad617233),
including its published `SuperDashboard-v1.0.0.snplg`.

It does **not** put an installable companion application inside a plugin. It
builds an Android APK, trims React Native libraries already supplied by
PluginHost, renames that APK to `app.npk`, then places it in the `.snplg`.
Its generated `PluginConfig.json` declares:

```json
{
  "reactPackages": ["com.dashboard.DashboardPackage"],
  "nativeCodePackage": "/app.npk"
}
```

PluginHost dynamically loads that code and instantiates the named
`ReactPackage`. SuperDashboard's `DashboardNativeModule` then successfully uses
ordinary Android APIs from the PluginHost context (intents, direct file I/O,
and a `WindowManager` overlay). This is the useful precedent for an Ola Ink
native bridge.

It is **not** evidence that the following will work for Ola Ink:

- an APK manifest activity can become a separately launched activity after it
  is placed in `app.npk`;
- a module can gain Android manifest permissions such as all-files access;
- AndroidX `WebViewAssetLoader`, a custom WebView `ViewManager`, IndexedDB, or
  WebCrypto work reliably under PluginHost; or
- plugin upgrades preserve WebView/IndexedDB state or provide APK-equivalent
  update authenticity.

The corresponding current official documentation is narrower but supports the
basic approach: plugins run in PluginHost, can call Java through React Native
TurboModules, have an `android/` native-code project, and PluginHost loads code
and assets from the installed plugin package. See [Plugin
Principles](https://docs.supernote.com/en/principle.md) and [Your First
Plugin](https://docs.supernote.com/en/first-plugin.md).

## Why this is a different security architecture

The current companion is a separately signed `com.olaink` APK. Its WebView
profile, WebCrypto private key, and Android Keystore namespace belong to that
app UID. An `.snplg` native module instead shares the PluginHost process and
UID with PluginHost and other native plugins.

The official permission model is helpful but insufficient proof for this
change. It explicitly protects direct native as well as SDK file/network calls,
gives each plugin a private directory, and requires declared/requested
`FILE:READ`, `FILE:WRITE`, and `INTERNET` permissions. It does **not** document
per-plugin WebView-profile isolation, Android Keystore isolation,
plugin-update-state preservation, or signed-plugin provenance. See [Plugin
Permissions](https://docs.supernote.com/en/plugin-base/permission.md).

In particular, a fixed local HTTPS origin such as
`https://appassets.androidplatform.net/` would be the same Web origin for every
PluginHost WebView. Merely giving Ola Ink a distinct host reduces accidental
collisions; it is not a proven defence against another native plugin executing
in the same host UID. Moving the private key from WebCrypto into Android Keystore
also does not establish a documented per-plugin trust boundary.

Therefore the spike must answer the security gates below with device evidence
and, where needed, a written statement from Supernote. If it cannot, retain the
separately signed APK for the production encrypted endpoint. A native plugin
may still be a useful non-production experiment.

## Desired plugin architecture, contingent on the gates

```text
NOTE toolbar button
  -> PluginHost renders Ola Ink React Native UI
     -> OlaInkPlayerView (native ViewManager)
        -> one local-only WebView and current `player.html`
        -> bridge: bounded note read / atomic inbox save / status
     -> PluginCommAPI.getCurrentFilePath() + PluginNoteAPI.saveCurrentNote()
     -> PluginHost permission prompt: FILE:READ, FILE:WRITE, INTERNET
     -> encrypted relay API
```

### Replacements for current APK responsibilities

| Current APK responsibility | Single-plugin replacement |
| --- | --- |
| Intent action, version parity, deep link | Remove. The toolbar opens the matching code in the same archive. |
| `MainActivity` full-screen WebView | `OlaInkPlayerViewManager`, mounted inside the existing plugin full-screen React Native view. Do not try to register an APK activity. |
| APK asset loader | Serve only canonical files from the installed Ola Ink plugin directory through a custom local HTTPS `WebViewClient`/path handler. Never permit arbitrary `file:`, `content:`, network, or navigation URLs. |
| `getCurrentFilePath()` path sent across an intent | Obtain the current path in the plugin, after saving the active note, and pass it only to the native bridge. The path must never enter the page, a URL, logs, or relay. |
| `MANAGE_EXTERNAL_STORAGE` | Remove. Request PluginHost `FILE:READ` before bounded source reads and `FILE:WRITE` before atomic saves beneath `/storage/emulated/0/Note`. |
| Android document picker fallback | Defer from MVP. The plugin starts from the active NOTE and does not need to export a URI grant. Add only after proving PluginHost activity-result support and permission behavior. |
| WebView IndexedDB key/profile owned by `com.olaink` | A security decision gate, not a mechanical port. Preserve the existing page only if PluginHost storage isolation and upgrade persistence are demonstrated. |
| companion polling while its activity is available | Sync on plugin open, explicit refresh, send, and visibility return. No headless receiver or persistent delivery claim. |

The native bridge continues to expose metadata and a one-shot local URL to the
page, not filesystem paths or plaintext note bytes. It must retain the current
5 MiB limit, canonical `/Note` containment checks, URL-safe base64 validation,
atomic destination writes, and filename sanitising. The plugin must never
introduce a stroke/page plaintext wire format.

## Phase 0 — time-boxed device spike (go/no-go)

Create this under `experiments/embedded-plugin/`, with a new throwaway plugin
ID. Do not change `olainksync00000001`, production pairing, or the release
workflow during this phase.

1. **Prove the package mechanism.** Start from the current official RN 0.79.2
   Supernote template. Add a minimal `OlaInkProbePackage` and
   `OlaInkProbeModule`, build an `app.npk`, and package it with explicit
   `reactPackages` and `nativeCodePackage` fields. Do not copy
   SuperDashboard's broad source scanner or its APK post-processing unchanged;
   make a small reviewed task that selects one arm64 `app.npk` output.
   - Inspect the archive: exactly one bundle, config, icon, test asset, and
     `app.npk`; inspect the NPK dex for the probe class.
   - On Nomad, install, open, update the same probe plugin ID, reboot, and
     uninstall. Capture `ReactNativeJS`, `PluginApp`, `PluginHost`, and
     `PluginInstallManager` logs.

2. **Prove PluginHost permissions and direct I/O.** Declare
   `plugin.permission.FILE:READ`, `plugin.permission.FILE:WRITE`, and
   `plugin.permission.INTERNET` in the generated config. Use
   `PluginManager.hasPermission()` then `requestPermission()` before each
   capability.
   - Call `PluginNoteAPI.saveCurrentNote()` and
     `PluginCommAPI.getCurrentFilePath()` from a real open note.
   - Have native Java read a bounded fixture/current `.note` only after
     `FILE:READ`; verify deny and allow-this-time-only fail/expire as the
     official permission model says.
   - Have native Java atomically create an inbox fixture only after
     `FILE:WRITE`; reject paths outside `/storage/emulated/0/Note` and confirm
     no all-files permission appears in system settings.
   - Verify direct HTTPS fails before `INTERNET` and succeeds after consent.

3. **Prove the WebView surface.** Implement a tiny legacy `ViewManager` that
   creates one `WebView` as a child of PluginHost's React root. Serve a
   canonical local `probe.html` and module via a locked-down HTTPS-looking
   origin; do not use `getAssets()` because those are PluginHost application
   assets, not necessarily the plugin archive. Prove:
   - ES modules, `crypto.getRandomValues`, `crypto.subtle`, IndexedDB, and the
     `supernote-viewer` worker path function;
   - back/close/reopen and rotation do not leak or retain an obsolete WebView;
   - navigation, redirects, mixed content, file access, content access, and
     unrecognised paths are blocked; and
   - a source URL can be read once by the WebView without exposing its host
     path to page JavaScript.

4. **Prove update and deletion semantics.** Store non-secret sentinels in each
   candidate location: plugin private directory, WebView IndexedDB/localStorage,
   and any proposed key store. Test same-ID update, downgrade attempt, host
   force-stop/reboot, plugin removal/reinstall, and a firmware update if
   available. A same-ID update must preserve the chosen device identity/key or
   the product needs an explicit re-pair/recovery UX.

5. **Resolve the endpoint-isolation gate.** Before importing real pairing or
   private keys, obtain a Supernote answer or reproducible proof for all of:
   - whether an app.npk native module can read another plugin's private
     directory or WebView storage;
   - whether PluginHost isolates Android Keystore aliases/operations by plugin;
   - whether different plugin WebViews can intentionally use the same local
     origin and access each other's IndexedDB; and
   - how PluginHost authenticates plugin archives and prevents a downgrade or
     modified update.

   **No-go condition:** absent a documented or independently reviewed boundary
   adequate for Ola Ink device keys, do not migrate the production endpoint
   out of `com.olaink`. Do not substitute obscurity (a random directory, key
   alias, or origin) for this boundary.

### Phase 0.1 implementation status

`experiments/embedded-plugin/` now contains the intentionally non-production
load probe described in step 1. It builds `olainkprobe.snplg`, whose generated
config declares `OlaInkProbePackage` and `/app.npk`; `verifyArchive.sh` checks
the archive and its dex for that class. Its local Gradle and archive checks
pass. The probe was installed and opened successfully on the Nomad on
2026-08-27: PluginHost loaded the NPK, instantiated the registered package,
and the React Native UI invoked `OlaInkProbeModule.describe()`. The exact
firmware/version evidence is recorded in `docs/research.md`. Version-code 2
then upgraded in place (`isUpgrade=true`) and Phase 0.2 verified denied and
user-consented direct Java read/write/HTTPS behavior. In particular, a
“this-time-only” grant remained usable after closing/reopening the view, but
was cleared by a PluginHost force-stop. This validates the package/load path,
scoped direct-I/O enforcement, and this firmware's temporary-grant lifetime.

### Phase 0.3 result — decisive no-go

Version-code 3 added a deliberately local-only native `WebView` view manager
and three static archive assets. On mounting it, Android threw
`UnsupportedOperationException: For security reasons, WebView is not allowed
in privileged processes` from `WebViewFactory.getProvider`; PluginHost then
closed the plugin view. `dumpsys activity` confirms PluginHost runs as UID
`1000`. Therefore ES modules, workers, WebCrypto, IndexedDB, and the pinned
viewer cannot be tested or used in this process. This failure is before asset
routing or page JavaScript and cannot be fixed by a different origin,
`WebViewClient`, or bridge.

Phase 0 does **not** exit successfully. Stop the migration here; retain the
remainder below only as the historical plan that would apply to a hypothetical
non-WebView rewrite, not as authorised implementation work.

## Superseded Phase 1 — feature-parity plugin (do not execute)

1. **Adopt native packaging.** Move the plugin to the official RN 0.79.2
   native-plugin project layout under `packages/plugin/android/`. Add only the
   minimal `com.olaink.plugin.OlaInkPackage`, native module, and WebView view
   manager. Make `packages/plugin/buildPlugin.sh` produce `app.npk`, copy the
   player assets into the archive, and generate these additional config fields:

   ```json
   {
     "uses-permissions": [
       "plugin.permission.FILE:READ",
       "plugin.permission.FILE:WRITE",
       "plugin.permission.INTERNET"
     ],
     "reactPackages": ["com.olaink.plugin.OlaInkPackage"],
     "nativeCodePackage": "/app.npk"
   }
   ```

   Preserve `pluginID: "olainksync00000001"`, increment plugin version code,
   and make the package build deterministic enough to inspect in CI. The
   separate `android/` APK remains untouched until rollout is complete.

2. **Port the player deliberately.** Keep `player.html` crypto and record
   framing unchanged initially. Replace `window.OlainkPlayer` with a narrow,
   audited bridge whose methods are asynchronous and validated:
   `sourceMetadata`, `openSelectedSource`, `clearSource`, `saveInboxNote`,
   `appVersion`, and `postStatus`. Remove plugin-install, return-to-companion,
   intent-parity, and all-files flows. The bridge only accepts a generated
   source token and encoded local plaintext; it never returns a path, URI, or
   note bytes to JavaScript beyond the controlled local response.

3. **Change entry and lifecycle.** The toolbar button should first save the
   active note, request needed permissions with user-facing reasons, fetch the
   current path, validate/select it natively, then mount the player in send
   mode. Add a plugin config button or a documented toolbar path for inbox and
   pairing when no note is open, if the firmware supports that entry. Closing
   the plugin destroys the player and stops sync cleanly.

4. **Use the existing service protocol unchanged.** Continue encrypting the
   complete `.note` byte sequence locally and uploading only opaque ciphertext
   records. Keep all relay/account protocol tests. New bridge code gets unit
   tests for path containment, size caps, token one-shot behavior, base64,
   atomic write failures, and permission refusal.

5. **Remove obsolete delivery code only after parity.** Delete the action
   stamping, APK-embedded plugin staging, Android intent tests, companion
   install UI, APK signing/release docs, and `MANAGE_EXTERNAL_STORAGE` code
   only after the single-plugin release has passed the migration soak. Keep
   the pinned viewer update mechanism, adapted to copy its asset into the
   plugin archive.

## Superseded Phase 2 — validation, migration, and rollback (do not execute)

### CI and archive checks

- Build the `.snplg` on a clean runner; unzip it and assert config fields,
  stable plugin ID, exactly one `app.npk`, expected native class, assets, and
  no unintended APK/keystore/build output.
- Run TypeScript/unit tests plus a native-Java test suite for bridge validation.
- Record hashes and size budgets for bundle, player asset, and NPK. Fail when
  the native package pulls in duplicate React Native/Hermes libraries that
  PluginHost already supplies.
- Preserve an explicit supported-firmware matrix. SuperDashboard itself
  publishes different plugin builds for pre- and post-permission-system
  firmware; Ola Ink must do the same if API/package compatibility requires it.

### Nomad acceptance test

1. Start from a paired stable APK and a known test note; back up test data.
2. Install the candidate plugin, grant/reject/regrant each declared permission,
   pair a test device, send a whole note, receive it, validate playback, and
   save it under `Note`.
3. Update the same plugin ID in place. Confirm the required device identity,
   encrypted inbox, and animation setting behavior matches the Phase 0
   persistence decision; test an old plugin archive and an interrupted update.
4. Reboot, force-stop PluginHost, open the plugin from NOTE, sync, then log
   out. Confirm logout removes the selected key/inbox state and server device
   capability without touching unrelated notes.
5. Exercise refusal/error paths: locked/encrypted source, no network,
   permission denial, oversized note, malicious path/token/base64, corrupted
   record, plugin removal, and reinstall.

### Rollout and rollback

- Publish the first archive as an **experimental** plugin release with exact
  supported firmware, permission explanation, no-background-sync limitation,
  hash, and rollback instructions. Do not migrate existing users' paired APK
  identities automatically.
- Users who opt in install one `.snplg` and pair it as a **new device**. The
  old `com.olaink` profile cannot be copied into PluginHost safely; preserve it
  until the user verifies a send and receive.
- Keep the signed APK available for at least one stable plugin release cycle.
  Rollback is: reinstall the prior stable APK, pair if necessary, and install
  the existing stable plugin. Never claim the two local key stores are
  interchangeable.
- Promote only after the endpoint-isolation gate, update persistence, full
  device matrix, and a security review are signed off. Otherwise keep the APK
  and improve its onboarding rather than weakening the encrypted endpoint.

## Success criteria

The plan succeeds only if one Ola Ink `.snplg` can be installed and upgraded
in place on supported firmware; it uses PluginHost's scoped consent instead of
all-files access; it encrypts/decrypts complete note bytes without exposing
paths or plaintext to the relay; it has no unsupported active-note hand-off;
and the key/update provenance boundary is at least as defensible as the
separately signed APK. Technical ability to load `app.npk` alone is not
sufficient.
