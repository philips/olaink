# Plan: production single-`.snplg` Ola Ink

Status: proposed productization plan.

This promotes the validated native file-exchange architecture into the stable
Ola Ink plugin. It replaces the APK-launcher plugin + companion APK workflow
with one React Native `.snplg` that talks to `https://app.olaink.com` by
default.

The accepted product decision is that PluginHost's shared UID/Keystore and
plugin-update limitations are a platform constraint. Treat the resulting
plugin-private storage as the product boundary; do not block this plan on a
per-plugin isolation mechanism Supernote does not provide.

## Product boundary

```text
React Native plugin                         NPK (Java)
------------------                          ----------
Inbox / Sent / Settings UX                  wrapped device identity
pairing-code and relay HTTP                 record-v1 encrypt/decrypt
permission and file/open UX                 bounded whole-.note I/O
in-memory UI state                          encrypted local record/journal store
```

- The fixed production relay origin is `https://app.olaink.com`; use normal
  WebPKI validation, no staging self-signed certificate or leaf pin.
- React owns all HTTP: pairing claim, directory lookup, upload, poll, ACK,
  logout, retry, timeout, and visible error states.
- NPK has no HTTP/TLS client. It keeps the device private key and performs
  P-256 ECDH, HKDF-SHA-256, AES-256-GCM, SHA-256, record validation, and only
  the bounded source/output file operations inseparable from crypto.
- A received file is atomically written to `Note/` then opened with
  `PluginFileAPI.openFile(path, -1)`. The Supernote Notes app renders it; the
  plugin never parses, previews, converts, animates, or renders `.note`.
- The relay receives opaque records and routing/delivery metadata only. It
  never receives note bytes, filenames, sender labels, or page/stroke data.

## UX from the handwritten mockups

The supplied mockups define a simple three-tab workspace:

1. **Inbox** (default) — received notes as rows: sender, filename, and local
   received date. Example rows shown are `User 1 / Hello.note / 2026-09-12`
   and `User 2 / Draft.note / 2026-09-10`.
2. **Send** — choose the active saved note, confirm the exact filename and
   recipient before encryption (the first mockup: “Would you like to send the
   note test123.note?” with **Yes**/**No**), then show a durable sent result.
3. **Settings** — pair the Supernote with a code created at
   `app.olaink.com`, show pairing/session state, and manage muted users. The
   mockup’s “Mute User” list hides selected senders from the default inbox; it
   does not delete their ciphertext or alter the sender's copy.

Use a high-contrast e-paper layout: large tab targets, no icon-only essential
actions, text-first rows, and explicit busy/error/retry states. No mockup
requires an in-plugin note preview.

## Durable local data model

The product needs a small encrypted local journal for useful Inbox and Sent
screens after a plugin close/reopen. Add it inside the NPK profile directory,
encrypted/authenticated with local wrapped-key material. Do not use
AsyncStorage, localStorage, or a shared external Ola Ink directory.

| Store | Contents | Purpose |
|---|---|---|
| identity | wrapped P-256 private key, device ID/SPKI, current paired-device session | crypto and React foreground session restoration |
| inbox record | original opaque relay record, record ID, received timestamp, local state | re-open/retry without plaintext note bytes |
| encrypted UI journal | sender, filename, size/digest, muted/read state, sent recipient/filename/time/result | populate Inbox/Sent and mute controls after reopen |
| external `Note/` output | complete user-visible `.note` only after explicit **Open** | Supernote Notes owns display and user file lifecycle |

Plaintext `.note` bytes never enter React or durable plugin storage. React asks
NPK for display metadata only when rendering its current screen. The journal
may contain user-visible filename/sender/recipient metadata; encrypt it at
rest and never send it to the relay or log it.

### Inbox synchronization

1. React polls the production relay in the foreground.
2. For each opaque record, NPK authenticates/decrypts only enough to validate
   it and derive display metadata, then atomically stores the original
   ciphertext record and encrypted journal entry.
3. React ACKs only after that durable local write. A malformed/tampered record
   is neither indexed nor ACKed.
4. Inbox lists non-muted journal entries. A muted sender is retained locally
   but excluded by default; Settings can unmute it.
5. **Open** asks NPK to decrypt the stored ciphertext to a collision-safe
   `Note/` filename with temp + `fsync` + rename. React ACKs the completed
   local record if needed, then calls `openFile`.

`openFile` stops the PluginHost JS runtime on current firmware. Any network
ACK required for durable receipt must finish after the encrypted local record
is stored and before `openFile`; an open failure leaves a complete file the
user can open from Notes.

### Send and Sent

1. From an active note, React calls `saveCurrentNote()` and requests
   `FILE:READ` at the action.
2. Send shows the confirmation sheet with recipient and current filename;
   **No** returns without reading/encrypting the file.
3. On **Yes**, React resolves the recipient directory at `app.olaink.com` and
   calls NPK to validate, hash, and encrypt the complete bounded `.note`.
4. React uploads the opaque record. On relay acceptance, NPK stores an
   encrypted Sent journal entry: recipient, filename, byte count/digest,
   timestamp, record ID, and recipient-device count.
5. Sent shows **Sent**, **Failed — retry**, or **Pending upload**. It must not
   imply that a recipient opened a note; the relay only confirms acceptance.

## Settings and onboarding

- Unpaired Settings shows the mockup instruction: visit `app.olaink.com`,
  sign in with the existing AuthGravity/passkey flow, select **Add Supernote
  companion**, then enter the eight-digit one-use code in the plugin.
- The plugin claims `/v1/pairings/claim` directly over React HTTPS using a new
  NPK public SPKI/device ID. It does not implement AuthGravity login or handle
  browser cookies/passkeys.
- Paired Settings shows Ola Ink address, relay/session health, last sync,
  **Sync now**, muted-user editor, and **Log out this Supernote**.
- Logout calls the relay device logout endpoint, clears local identity,
  ciphertext, journals, and any pending plaintext temporary, then returns to
  the pairing screen.
- A newly paired plugin has a new device key and receives future sends. It
  cannot recover notes addressed only to the retired APK identity; communicate
  this during migration and keep the old APK available until the user confirms
  a successful plugin pairing and send/receive check.

## Production service and release work

### P0 — production relay readiness

**Initial check (2026-09-22): partial pass.** `app.olaink.com` has a valid
Let's Encrypt certificate for its exact hostname, `/healthz` returns `ok`, and
the Supernote-origin pairing preflight returns the expected restricted CORS
headers. The current production `/` returns JSON 404 rather than the browser
login/pairing page implemented in this repository. Deploy the current server
build (or route `/` to its onboarding handler) before asking a production user
to create a pairing code; this blocks P1 device pairing but does not require
any security-boundary change.

- Serve `https://app.olaink.com` with a publicly trusted certificate,
  redirect-free API origin, production DNS, monitoring, backup/restore, and a
  separate production SQLite/database deployment.
- Configure `AUTHGRAVITY_WHOAMI_URL` for
  `https://authgravity.app.olaink.com/v1/whoami`; verify AuthGravity RP ID and
  browser pairing setup at `app.olaink.com`.
- Retain the existing device-session authorization and strict recipient
  directory/version validation. Align client/server request and response caps
  with the 5 MiB whole-note product limit.
- Complete the server README's pre-production gaps: durable proxy-aware rate
  limits, retention/expiry policy and jobs, audit events, operational alerts,
  and device revocation support.
- Restrict companion CORS to the PluginHost React origin required by the
  Supernote runtime; reject redirects and any non-production origin.

Exit: a public WebPKI Android/PluginHost fetch reaches only
`https://app.olaink.com`, and production monitoring/backup/abuse controls are
exercised.

### P1 — stable plugin foundation

- Create a production native plugin source/package by promoting the revision
  11 architecture, not by copying staging IDs, keys, relay files, fixtures, or
  E2 harness code.
- Upgrade the committed stable plugin in place with
  `pluginID: "olainksync00000001"`; preserve this ID and increment version
  code for every release. Its new description must say encrypted whole-note
  exchange, not APK launch.
- Replace the current intent-launch bundle and remove companion action,
  Android APK assumptions, staging relay configuration, fixture controls, and
  experiment diagnostics.
- Ship `relay.json` with only `{"base":"https://app.olaink.com"}` (or a
  compile-time equivalent); archive verification must reject IP literals,
  staging hosts, self-signed pins, `file://`, WebView, viewer/SVG/converter
  dependencies, APK payloads, and private material.
- Keep `FILE:READ`, `FILE:WRITE`, and `INTERNET` declared; request each only
  for its user action.

Exit: the stable archive contains exactly React UI, one NPK, icon, production
origin config, and committed protocol vectors.

### P2 — NPK production profile and journal

- Replace experiment-named aliases/directories/classes with stable names.
- Implement authenticated encrypted journal schemas, atomic update/recovery,
  bounded record count/size, collision-safe external output, and cleanup on
  logout/uninstall failure paths.
- Expose narrow native methods for identity, session restoration, pairing
  result persistence, inbox metadata/index, encrypted-record staging,
  send-record creation, decrypt-to-Note, sent journal, mute list, and clear.
- Return no keys, session token in UI/log output, source/destination paths,
  ciphertext, or note bytes to React. A short-lived session capability may
  cross to React memory solely to perform foreground relay HTTP.

Exit: close/reopen preserves Inbox/Sent/Settings state without durable
plaintext note bytes or readable journal metadata.

### P3 — React product screens

- Implement the three tabs and routes from the mockups. Inbox is the default;
  Send is available from the sidebar and active-note context; Settings works
  without an active note.
- Implement explicit confirmation, empty/loading/offline/retry/expired-code/
  revoked-session/permission-denied states and accessible focus behavior.
- Add Inbox row actions: **Open**, **Mute**, and delete local encrypted copy;
  add Sent actions: retry pending upload and remove local history.
- Use foreground-only **Sync now** and refresh on returning to the plugin;
  do not add background polling.

Exit: the mockup flows are usable entirely in the stable `.snplg` and no
screen loads a browser viewer.

### P4 — migration, verification, and rollout

- On first stable-plugin launch, show a one-time migration explanation and
  pairing path. Do not attempt to copy APK keys, browser keys, or existing
  queued plaintext.
- Test pairing, send confirmation cancel/accept, two-device receive/open,
  muted sender, Sent persistence, logout/re-pair, offline retry, tampered
  record, expired/reused pairing code, revoked device, and all file permission
  outcomes.
- Run force-stop during journal writes and note output; reboot, upgrade,
  downgrade rejection, uninstall/reinstall, relay restart, and database
  restore tests. Verify no partial note, premature ACK before durable record
  storage, readable journal, key, token, or note bytes in logs/archive.
- Release the upgraded stable `.snplg` with rollback instructions. Retire the
  APK only after a defined migration window and telemetry/support review; keep
  a user-visible way to retain it during that window.

## Acceptance criteria

- The installed stable `olainksync00000001` plugin defaults to
  `https://app.olaink.com`; no companion APK is needed for normal use.
- Inbox, Sent, and Settings match the supplied interaction model and survive a
  close/reopen using encrypted local state.
- A valid whole `.note` is encrypted before upload, delivered as ciphertext,
  atomically written only on explicit open, and displayed only by Supernote
  Notes.
- The production archive has no WebView, SVG renderer, animation/converter,
  `supernote-viewer`, browser crypto, or staging endpoint.
- Production service operations, migration, and destructive lifecycle tests
  pass before APK retirement.
