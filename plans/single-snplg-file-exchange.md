# Plan: one `.snplg` file exchange — no in-plugin rendering or animation

Status: active disposable experiment; F0/F1/F3 functional workflow passes recorded below.

This replaces the failed “convert `.note` → SVG → animate it in the plugin”
branch with a simpler workflow:

```text
React Native plugin UI                         NPK (Java)
----------------------                         ----------
pair / account web API                  device key + record crypto
inbox / send / error UX                 encrypt complete .note bytes
save / open file UX                     decrypt + validate complete .note bytes
PluginFileAPI.openFile()                atomic plaintext file output
```

A received note is **not rendered in the plugin**. After decryption it is
written as a complete `.note` file and opened with Supernote’s own
`PluginFileAPI.openFile(path, -1)`. The Supernote note app is the only viewer
and renderer. There is no SVG, scene model, animation, Canvas player,
`supernote-viewer`, WebView, `image-js`, Hermes converter, or second JS engine.

The relay still sees only opaque `EncryptedNoteRecordV1` records. There is no
page/stroke transport format and no server-side note parsing.

## Important feasibility fact

The current plugin SDK exposes `saveCurrentNote()`, `getCurrentFilePath()`,
`PluginFileAPI.openFile()`, and path-level operations such as copy/rename/list
through `NativeFileUtils`. It does **not** expose a documented React Native API
that reads arbitrary file bytes into JS or writes arbitrary byte arrays from
JS. Therefore “React reads/writes files while NPK does crypto only” cannot be
literal with the available SDK: encryption must receive bytes and decryption
must emit bytes.

Use this narrow split instead:

- **React owns all user-visible file actions and paths:** save current note,
  obtain the selected/current path, request `FILE:READ`/`FILE:WRITE`, choose a
  destination filename, call `openFile`, and display only public status.
- **NPK owns the unavoidable bounded stream I/O that is part of cryptography:**
  open the already-authorized source only while hashing/encrypting, and create
  the decrypted output only while authenticating/decrypting. It exposes no
  general read/write/file-browser API and never returns note bytes to React.

If Supernote adds a documented byte stream/`content://` API usable directly by
React Native, use that API. Until then React passes the SDK-returned path only
to its own NPK native-module method after the scoped permission check; it must
not use `fetch(file://)`, an intent, or a fixed shared OlaInk directory.

## Scope

### Included

- One experimental plugin ID only; existing APK and stable plugin remain.
- Pairing and account/session API calls from React Native with `fetch`.
- React inbox, send, pending/error, file-save, and “Open in Notes” screens.
- NPK implementation of existing record v1 encryption/decryption.
- Whole-file SHA-256 verification, bounded streaming, atomic output, and
  cleanup on failure.
- Opening saved received notes through `PluginFileAPI.openFile(path, -1)`.

### Explicitly excluded

- SVG, SVG scenes, Canvas replay, page extraction, OCR, animation, preview,
  editing, append, thumbnails, and parsing `.note` format.
- WebView, PWA, IndexedDB, WebCrypto, `supernote-viewer`, and any JS runtime
  embedded in the NPK.
- Background polling; React sync is explicit and foreground-only.
- Production identities, account, plugin ID, or removal of the APK.

## Security boundary

NPK keeps the device private key and performs the existing v1 protocol exactly:
P-256 ECDH recipient slots, HKDF-SHA-256, AES-256-GCM, canonical base64url,
existing AAD, and complete-file SHA-256. React receives only:

```text
send result: record ID, byte count, SHA-256, recipient count
inbox result: record ID, sender, filename, byte count, received time
save result: sanitized filename, success/failure
```

React never receives a private key, session token if avoidable, plaintext note
bytes, a cipher key, or unrestricted file contents. Do not log source or
destination paths, ciphertext, note names outside currently visible UI, or
bytes.

E1 remains decisive: PluginHost shares a UID and Android Keystore alias space
with other native plugins; equal-version/same-ID archives were accepted without
observed content authenticity. This experiment may prove workflow only. It is
not a candidate replacement for the APK unless Supernote supplies a stronger
security boundary.

## API shape

### React → relay web API

React owns network UX. It uses bounded `fetch` requests to the staging relay,
with a fixed HTTPS origin, no redirects, timeout/abort controller, response
caps, and redacted errors. It asks the NPK to create or consume encrypted
records; it never implements crypto in JavaScript.

```text
createPairing(code)                    -> public pairing/account metadata
lookupRecipient(username)              -> public device directory
uploadEncryptedRecord(record)          -> accepted record ID
pollInbox()                            -> opaque encrypted records
ackRecord(recordID)                    -> acknowledgement
```

The exact endpoint/capability design must preserve the E2 device-session
boundary. Moving HTTP calls to React does not justify storing a long-lived
plaintext session token in React state or AsyncStorage; use a native-held
capability header or a short-lived foreground credential bridge.

### React → NPK crypto/file endpoints

```text
ensureExperimentalIdentity() -> public device ID + SPKI
createEncryptedFileRecord(sourcePath, filename, sender, recipientDirectory)
  -> opaque EncryptedNoteRecordV1 + public SHA-256/counts

decryptRecordToNote(record, destinationName)
  -> { filename, byteCount, sha256, saved: true }

clearIdentityAndCiphertextState()
```

`createEncryptedFileRecord` must canonicalize the selected source underneath
an allowed Note root, require `.note`, reject symlinks/locked/changing/
oversized files, stream rather than load the whole file when protocol framing
allows, and recheck size/identity after read. The method accepts a path only as
a transient, permission-checked capability; it must not retain or return it.

`decryptRecordToNote` validates routing, payload MIME, filename, SHA-256, and
size before atomically placing the whole note in the permitted `Note` folder:
write a same-directory temporary file, `fsync`, validate digest, rename, and
remove the temporary file on every failure/cancellation. It returns a
sanitized basename only. React then calls `PluginFileAPI.openFile` using the
user-visible destination it selected.

## User flows

### Send current note

1. User opens the experimental plugin from a NOTE sidebar entry.
2. React calls `PluginNoteAPI.saveCurrentNote()`.
3. React requests `FILE:READ` at this action and obtains the current path only
   through the supported SDK method under test.
4. React requests/uses Internet and resolves recipient directory through the
   relay.
5. React passes the path and public directory to NPK.
6. NPK streams, hashes, encrypts the **complete** note, and returns an opaque
   record. React uploads it and shows accepted/failed status.
7. NPK releases source descriptors and clears temporary buffers.

React and the NPK are in the same PluginHost process, so the reviewed native
module bridge is the only bridge used here. No Android intent is needed or
allowed for plugin↔NPK file access.

### Receive and open

1. User opens the plugin normally and selects **Refresh**.
2. React polls the relay and displays ciphertext routing/public metadata.
3. User selects **Save and open**; React requests `FILE:WRITE`.
4. React passes the opaque record and a collision-safe requested basename to
   NPK.
5. NPK decrypts/authenticates/validates and atomically writes the whole note.
6. Only after successful write does React acknowledge the record.
7. React calls `PluginFileAPI.openFile(savedPath, -1)`; the Supernote note app
   opens the complete saved `.note`.

A decrypt, validation, or write failure must leave the relay item
unacknowledged and must not leave a partial output file. `openFile` stops the
PluginHost JS runtime on this firmware, so React must acknowledge the complete,
fsynced output **before** calling it. If the subsequent system open fails, the
record is acknowledged but the complete user-visible Note file remains for
manual opening; do not claim an impossible post-open React ACK.

## Phases and acceptance gates

### R0 — retire the renderer branch

- Remove the E0 hard-coded Canvas view, E3 converter bundle, SVG/scene
  fixtures, E3 compatibility shims, renderer controls, and their archive
  members from the experimental `.snplg`.
- Keep the E3 failure report and converter provenance only as research records;
  do not retain the runnable memory-heavy conversion button.
- Verify the resulting archive has no `supernote-viewer`, WebView,
  `image-js`, SVG-scene converter, or animation dependency.

Exit: the experiment’s only note display action is `PluginFileAPI.openFile`.

### F0 — SDK/file contract probe

**Nomad result (2026-09-21): initial pass.** From the NOTE sidebar, React
saved the active note and obtained its SDK current path after one-time
`FILE:READ` consent; the NPK accepted the root-constrained 119,772-byte
`.note` and returned only its filename, byte count, and SHA-256. After
one-time `FILE:WRITE` consent, the NPK copied it through a same-directory temp
file + `fsync` + rename to `OlaInk-F0-1790041848342.note`; Supernote returned
to `NoteInsidePagesActivity`, and the saved file size matched the source.
No SVG/viewer/converter loaded. This proves the narrow in-process RN→NPK path
works on this firmware, not an inter-app content grant or a production safety
boundary.

On Nomad with throwaway fixture notes:

- Verify `saveCurrentNote`, current-path retrieval, permission denial/grant,
  and `PluginFileAPI.openFile` behavior.
- Verify the path is restricted to the allowed Note root and whether it remains
  valid through plugin close/force-stop.
- Verify `FILE:WRITE` permits NPK’s same-directory temporary + rename path.
- Verify React/SDK can select a destination and open it after write.

Exit: a documented, supported path/grant contract exists. Failure blocks F2/F4.

### F1 — native record crypto remains compatible

**Implementation staged (2026-09-21); relay round-trip pending.** The native
`e2SendFile(sourcePath, recipient)` endpoint now reuses the E1 v1 crypto path
for a root-constrained, stable whole `.note` and returns only record ID, byte
count, SHA-256, and recipient-slot count. React saves the active note, obtains
its transient SDK path after `FILE:READ` consent, and calls that endpoint;
the E3 renderer remains absent. The current v1 payload requires one bounded
in-memory note buffer (5 MiB cap), so this is deliberately not called a
streaming implementation. Archive and Java unit builds pass.

**Nomad/peer result (2026-09-21): pass.** With a fresh throwaway pairing,
React requested scoped `FILE:READ`, saved the current note, and invoked the
NPK whole-file send. It emitted record
`3f8cc5f9-97c7-4861-a199-d9d277d734c5` for 151,320 bytes and SHA-256
`KTaDpKZY0xA9st9dVqLMGVa_a1ER4LJkeQEuV91nV4M`. The independent Node
WebCrypto peer decrypted the same whole file, reported the same filename,
length, and digest, then acknowledged it. No note bytes/path entered logcat.

- Retain Java ↔ independent Node/WebCrypto vectors from E1.
- Add streaming/file tests: input digest equals decrypted output digest;
  tampered tags/AAD/wrong slot/malformed record fail with no output.
- Cap every input and report only redacted evidence.

Exit: byte-identical whole-file round trip across two independent peers.

### F2 — React relay and inbox shell

**Transport prerequisite (in progress):** direct React Native `fetch` cannot
use the disposable self-signed/pinned leaf accepted by the old NPK
`RelayClient`; RN exposes no supported certificate-pinning override. The
experiment now includes a React-owned bounded `/healthz` fetch probe and a
relay helper to replace that leaf with a WebPKI-valid Tailscale
`<machine>.ts.net` certificate. Do not move pairing, inbox, or bearer session
transport out of NPK until that probe passes on Nomad; otherwise an apparent
React transport implementation would be untestable or would weaken TLS.

**Nomad result (2026-09-22): functional pass.** The relay now serves a
WebPKI-valid Tailscale certificate for `macmini.rhino-dragon.ts.net`; host
`curl` returned `ok`, and revision 8's React Native `/healthz` probe passed on
Nomad. In revision 10 React directly claimed a one-time pairing code, polled
one opaque inbox record, resolved the public recipient directory, uploaded an
NPK-created whole-note record, decrypted it through the NPK, ACKed the
complete atomic output, and opened it in Notes. A later React poll returned
only the deliberately tampered unacknowledged record. The self-signed
certificate remains unacceptable for this React-owned transport. Revision 11
then removed `RelayClient`, all Java HTTP/TLS imports, and every native
pair/send/poll/ack/logout bridge; the NPK archive contains only identity,
crypto, bounded crypto-adjacent file I/O, and local ciphertext/profile state.
A post-upgrade React poll still returned only the deliberately tampered record.

- Implement unpaired/pair/send/inbox/settings screens without a renderer.
- Prove explicit foreground poll/upload, cancellation, offline, malformed
  relay response, expired pairing, revoked session, and duplicate poll.
- Persist only ciphertext + minimal delivery state in the plugin-private tree;
  no plaintext note or decrypted metadata cache.

Exit: React controls the complete staging relay workflow using only opaque
records and public UI metadata.

### F3 — atomic decrypt-to-Note and system open

**Nomad result (2026-09-21): functional pass.** A 41,134-byte handwritten
throwaway note was saved, encrypted by the NPK, then received through the
staging relay. The NPK wrote `OlaInk-Received-…` with temp + `fsync` + rename,
acknowledged only after the write, and `PluginFileAPI.openFile` closed the
plugin and opened the note in Supernote Notes with its visible stroke. An
external device-side SHA-256 comparison of source and output matched:
`78d130f2c094fcf846b15ce81547784325a063c36cf839e1bf6e791451f6dc0d`.
The initial matching native log was `F3 saved+acked` for 41,134 bytes. A
separate AES-GCM-ciphertext-bit-flip test produced `ProtocolException`, left
the plugin foreground, and left the received-output count unchanged; the
record was not acknowledged. Revision 9 moved relay calls to React and exposed
a firmware constraint: `openFile` stops that JS runtime before a post-open
React ACK can run. The React flow therefore ACKs the complete fsynced output
before `openFile`, matching the ordered receive flow above. This is a
same-account loopback workflow proof; an independently sent valid `.note` and
interruption cases remain required.

- Decrypt a peer fixture to a sanitized collision-safe Note filename.
- Compare original and written SHA-256 externally.
- Call `PluginFileAPI.openFile(destination, -1)` and prove Supernote opens the
  saved note.
- Force-stop during each write phase; verify no partial note and no ACK before
  the atomic output exists. Verify the post-write/pre-open ACK and retry policy
  is explicit.

Exit: two-device receive → save → Supernote-open succeeds without a viewer in
the plugin.

### F4 — current-note send

- Complete F0 source-contract proof.
- Send an active saved note to the independent peer; peer verifies complete
  byte SHA-256.
- Repeat denied permission, locked note, changing note, bad recipient,
  timeout, and cancellation cases.

Exit: active note → opaque record → peer whole-file verification succeeds.

### F5 — lifecycle and destructive checks

**Initial Nomad result (2026-09-22): pass.** Revision 11's React-owned logout
successfully invalidated the staging device session and invoked the NPK local
profile clear. A fresh peer pairing code then created a new NPK identity and
was claimed through React HTTPS after close/reopen. This does not cover the
remaining destructive cases.

- Close/reopen, force-stop, reboot, upgrade/downgrade, uninstall/reinstall,
  logout, and interrupted upload/download.
- Inspect plugin storage, external Note folder, relay database, archive, and
  logcat for plaintext temporaries, note bytes, keys, tokens, paths, and
  unacknowledged/duplicate records.

## Decision

A functional pass proves a plugin can exchange complete `.note` files and let
the native Supernote app display them. It does **not** change the E1 security
no-go. Keep the APK + stable plugin unless the independent per-plugin key and
update-authenticity gates are resolved.
