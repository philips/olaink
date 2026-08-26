# Web inbox for encrypted Ola Ink notes

## Goal

Let a person with an Ola Ink account receive, list, open, and replay encrypted
whole `.note` files at `https://app.olaink.com/`, even when they do not own a
Supernote or any other device capable of creating a note.

The web inbox is a recipient client, not a note authoring surface. It does not
create, edit, reconstruct, or transmit note plaintext. It registers a browser
receiver key, decrypts deliveries addressed to that key, and renders received
notes with the pinned Supernote viewer.

This plan builds on [`usernames.md`](usernames.md): a sender addresses a person
by immutable username, while the relay continues to use the recipient's opaque
account ID and public device directory.

## Product flow

```text
new browser user                         sender with a note-capable client
----------------                         --------------------------------
passkey login
  -> choose immutable @username
  -> create local inbox receiver key
  -> register its public key
  -> Inbox: “Share @username”                 resolve @username
                                                   -> receiver directory
                                                   -> E2EE encrypt whole .note
                                                   -> opaque relay delivery
browser opens/polls Inbox
  -> download record for local device
  -> ECDH/HKDF unwrap + AES-GCM decrypt locally
  -> verify encrypted metadata/hash and parse note
  -> persist inbox entry locally
  -> acknowledge this device's delivery
  -> list/open/replay in the browser
```

The relay sees the recipient's routing account/device IDs, ciphertext size,
timing, and acknowledgement. It does not receive note bytes, filename, sender
display data, plaintext preview, or the inbox private key.

## Key decisions

### A browser inbox is a real recipient device

After AuthGravity login and immutable username setup, `app.olaink.com` creates
a non-extractable P-256 ECDH key in that browser profile's IndexedDB. It
registers the public SPKI as an `inbox_<random>` device in the account's
existing device directory. A sender encrypts one key slot for this browser just
as it would for a Supernote companion.

This is what lets a person receive a note without owning a creator device. They
need only a passkey-capable browser and a persistent browser profile; no
Supernote plugin, Android APK, Storage Access Framework access, or note source
is involved.

The key must never be derived from the AuthGravity credential or transmitted to
AuthGravity. AuthGravity proves control of the account only; it cannot decrypt
notes.

### Receiving requires prior enrollment, and key loss is real loss

The relay can retain a note for an enrolled inbox device while it is offline,
but it cannot encrypt retrospectively for a browser key that did not exist when
the sender sent the note. The onboarding UI must therefore complete browser
key enrollment before displaying the share address.

If IndexedDB/site data is cleared or the browser profile is lost, that device's
private key is lost. A replacement browser can enroll a new key but cannot
recover messages encrypted only for the old key. Show this plainly during setup
and before any local-data reset. Future recovery/export work is separate and
must not weaken E2EE by making private keys server-recoverable.

A user can later enroll a second device; it receives only future sends unless
an existing device deliberately decrypts and re-encrypts a retained note for
it. This is the same directory-snapshot rule as the whole-note service.

### Inbox data is local and encrypted before persistence

Use a versioned IndexedDB inbox store keyed by record ID. Persist the original
opaque encrypted record plus only non-sensitive local state (such as read,
received, and retry status). On startup, decrypt verified records locally to
construct the list; do not persist filename, sender name, note bytes, or other
decrypted metadata by default. This makes the durable inbox cache ciphertext,
even on browsers that do not provide platform-level profile encryption.

If later performance work requires a metadata or note cache, encrypt each cache
entry with a distinct non-extractable local WebCrypto AES-GCM storage key kept
in the same browser profile, define its rotation/loss behavior, and threat-model
that feature first. Never place note bytes in localStorage, URLs, query
parameters, logs, analytics, or a service-worker cache shared with untrusted
origins.

For the prototype, read/unread, labels, and deletion are local to an inbox
browser. The relay's acknowledgement only means that this device durably
received the ciphertext; it is not a cross-device “read” state. Any future
cross-device inbox-state sync must be an authenticated, E2EE design.

## Root-site experience

Turn the root page into a small account shell with explicit states rather than
a pairing-only form:

1. **Signed out:** offer AuthGravity passkey registration and login.
2. **Signed in, no username:** require the immutable username claim described
   in `usernames.md`. Do not show a usable recipient address yet.
3. **Named, no local inbox device:** explain the browser receiver key, create
   it in IndexedDB, register its public key, and show recoverability guidance.
4. **Named and enrolled:** show the Inbox as the default view. The header shows
   read-only `@username`, a copy/share control, sync status, and an “add a
   device” path. There is no compose or note-creation action in this phase.

The Inbox view contains:

- empty state: “Share `@username` with someone to receive an Ola Ink note”;
- a newest-first list of verified received notes, with encrypted sender name,
  filename, received time, size, unread/read state, and failure state;
- an item detail/viewer pane that loads the selected bytes into the pinned
  `<supernote-viewer>` with `presentation = 'write-on-paused'`;
- retry/sync controls and actionable errors for offline, decryption, malformed
  record, unsupported note, local-storage, and account/device-revoked states;
- a local delete control that removes the local cached item only after an
  explicit warning. It must not claim to delete a sender's copy or undo relay
  delivery.

Use route state such as `/#inbox` only after the server's `/` response loads;
the server need not add a second public HTML route. Do not put record IDs,
recipient IDs, filenames, credentials, or note bytes in URLs.

The current editable AuthGravity endpoint input is useful for local testing but
must not be a normal production control. Production root setup fixes it to
`https://authgravity.app.olaink.com`; test builds can opt in to an override.

## Delivery, decryption, and acknowledgement

1. The inbox calls an authenticated, device-bound poll endpoint for its local
   device. It must not use the current public `deviceId`-only prototype poll.
2. For every returned record, validate the record shape, recipient account,
   directory/version invariants, and matching key slot before any decryption.
3. Derive the wrapping key with the existing P-256 ECDH/HKDF-SHA-256 contract,
   unwrap the content key, AES-GCM decrypt, and validate the inner format,
   filename/type/size/hash bounds, and `.note` parser/viewer compatibility.
4. In one IndexedDB transaction, persist a deduplicated verified inbox entry
   and the recoverable encrypted record/cache. Do not acknowledge before this
   succeeds.
5. Acknowledge only after successful decryption, integrity validation, local
   persistence, and the required viewer parse/load check. If any stage fails,
   keep the relay delivery unacknowledged and show a retryable failure without
   logging sensitive contents.
6. Repeated poll responses must be idempotent: an already persisted record may
   be revalidated and acknowledged without creating duplicate list entries.

The server retains a ciphertext until every device included in the sender's
directory snapshot has acknowledged (or documented retention expiry applies).
Adding a browser inbox device after sending does not alter that snapshot.

## Sender identity and recipient resolution

A sender enters `@username`; the sender client normalizes it with the product
username contract and resolves the active username to the recipient's opaque
account ID and public device directory. The caller does not submit a recipient
`userId` directly.

Include the sender's immutable username and any display label inside the
already encrypted inner metadata. The inbox shows it only after successful
decryption. Do not add plaintext sender name, filename, preview text, or
read-state fields to relay records merely to make the list convenient.

A recipient lookup for a retired or unknown username must return the same
non-resolvable response. Rate-limit public lookup if it remains unauthenticated
and decide separately whether directory discovery requires a signed-in Ola Ink
account.

## Required server and client changes

### Server

- Implement the immutable username/account endpoints and active username
  directory resolution from `usernames.md`.
- Replace prototype public registration, upload, poll, and acknowledgement
  authorization with account/device-bound authorization. A device must prove
  it is enrolled for the account it polls; only an authorized sender may obtain
  a directory and submit a record for that recipient.
- Preserve exact-directory validation and per-device delivery acknowledgement.
  Add record-size limits, retention/expiry jobs, durable proxy-aware rate
  limits, audit events that contain no ciphertext/plaintext, and revocation
  behavior before calling the inbox production-ready.
- Return stable machine error codes that let the UI distinguish auth,
  unconfigured username, unknown/revoked device, empty inbox, malformed
  delivery, and rate limiting without exposing hidden account data.

### Web client

- Split the current embedded onboarding page into testable PWA modules:
  AuthGravity session adapter, immutable account setup, IndexedDB device-key
  store, encrypted relay client, inbox store, and viewer adapter. Keep the
  built root page embedded in the single Bun binary.
- Add a browser-compatible crypto package with WebCrypto interoperability
  vectors against `prototypeNoteCrypto.ts`, strict base64/length parsing, and
  negative/tampering tests.
- Bundle/self-host the exact pinned viewer assets for the root web client under
  an allowlisted first-party origin. Apply a restrictive CSP, avoid third-party
  scripts, and ensure the viewer cannot cause note bytes to leave the origin.
- Poll on startup, after login, on visibility/network recovery, and with a
  bounded backoff while the inbox is open. Service-worker push/background sync
  is out of scope until it can be shown not to expose ciphertext or keys.
- Add accessible keyboard and screen-reader states; a note replay remains the
  viewer's responsibility, not a new stroke renderer.

### Android companion interaction

The Android WebView may use this same inbox profile once it has an enrolled
receiver key, but the inbox must work first in an ordinary desktop/mobile
browser. Receiving does not depend on the unresolved safe current-note handoff
or on owning the companion. The companion's future Share path can use the same
recipient lookup and relay client to send notes to browser-only accounts.

## Implementation sequence

1. Complete immutable username persistence, account setup, and authenticated
   device authorization; do not build an inbox atop the public-ID prototype
   endpoints.
2. Extract shared browser WebCrypto, directory lookup, relay polling, and
   IndexedDB key primitives with cross-runtime test vectors.
3. Implement browser inbox-device enrollment and account/device lifecycle UI.
   Test offline enrollment completion, restart, and replacement-device warnings.
4. Implement encrypted inbox persistence, polling/decrypt/verify/ack pipeline,
   deduplication, error states, and local read/delete controls.
5. Integrate the pinned viewer and test real `.note` fixtures in supported
   desktop/mobile browsers and the Android WebView.
6. Add two-account end-to-end tests: a note-capable sender sends to a
   browser-only recipient, which receives it after being offline and replays it
   without any Supernote hardware.
7. Document retention, loss/recovery limits, supported browsers, and the fact
   that the relay cannot add a new device to historic ciphertext.

## Acceptance checks

- A new passkey user can choose an immutable username, enroll a browser inbox
  key, and receive at that username without installing the Android companion or
  owning a Supernote.
- A sender resolves only the recipient username and encrypts a whole `.note`
  to the browser device directory; a server/database capture has no note
  plaintext, filename, sender name, or private key.
- A note sent while the inbox browser is closed remains available when that
  enrolled browser next signs in and syncs.
- The client does not acknowledge a record until it has successfully decrypted,
  validated, locally persisted, and loaded/parsed it; retries do not duplicate
  inbox rows.
- Clear-site-data/device-loss behavior is explicit: a replacement browser
  cannot decrypt records addressed only to the lost key, while future sends
  include its newly enrolled key.
- A person cannot poll or acknowledge another account's device by guessing an
  ID, and a sender cannot substitute a raw recipient account ID for username
  resolution.
- The web inbox renders/replays received files but exposes no note-create or
  note-edit function.
- All listed UI metadata comes from decrypted content; URLs, logs, relay
  records, and analytics do not contain filenames or note bytes.
