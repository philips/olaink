# Issue #15 — end-to-end encrypted note service

Issue: <https://github.com/philips/wrtn/issues/15>

## Decision summary

Replace the anonymous username/token relay with authenticated accounts, a
per-user device-key directory, and opaque retained ciphertext records. Keep the
current normalized-page payload as the plaintext application format; encrypt it
before it crosses the network. Use AuthGravity only to authenticate a person
and authorize account/device mutations. It is not the note-encryption key
service.

The existing Supernote client is a React Native Supernote plugin, **not a
browser PWA**. It has neither IndexedDB nor a verified WebCrypto/secure-key
storage capability. Treat Supernote encrypted delivery as a platform spike and
do not promise the issue's IndexedDB design on that surface until it passes.
The new scanner/mobile PWA can use non-extractable WebCrypto `CryptoKey`s in
IndexedDB.

## Goals

- A person claims one unique, normalized username after AuthGravity sign-in.
- Each enrolled device owns its own non-exportable private encryption key.
- Senders encrypt a fresh content key to every active recipient device. The
  relay retains and routes ciphertext but cannot decrypt pages.
- A phone/laptop with AuthGravity can add a Supernote through a short-lived,
  single-use pairing flow; the Supernote does not need passkey support.
- Existing offline delivery, acknowledgement-after-note-append, and normalized
  Supernote geometry remain intact.

## Non-goals for the first release

- Forward secrecy, group messaging, key backup/export, recovery of ciphertext
  addressed solely to a lost device, or automatic historic-message access for a
  newly enrolled device.
- Hiding traffic metadata from the relay: it will still know account/device
  identifiers, message sizes, delivery/acknowledgement times, and recipients.
- Claiming resistance to a malicious directory service before a key-directory
  authenticity mechanism is selected.

## Feedback on the issue

1. The desired account model is sound, and per-device recipients are necessary:
   acknowledging a single user mailbox would otherwise cause the first device
   to receive a page to delete it for every other device.
2. The proposed `accessList` must be keyed by **device key ID**, not user ID.
   One wrapped content key is required for every active recipient device. Keep
   the immutable public-key fingerprint alongside a random device ID so key
   rotation and revocation are unambiguous.
3. Encrypt and authenticate the whole note payload with a randomly generated
   content key. Do not directly encrypt arbitrary page JSON once per recipient.
   AES-GCM requires a fresh unique 96-bit IV for every use of a key; use a new
   random AES-256 content key per record. Include the schema version, record
   ID, recipient account ID, and key-directory version as AEAD additional
   authenticated data.
4. Do not adopt `e2ee.js` unchanged. Its documented construction is
   ECDH + AES-CTR, while the issue calls for AES-GCM and needs explicit
   authenticated record/envelope semantics. Prefer a small, reviewed wrapper
   over native WebCrypto using P-256 ECDH + HKDF-SHA-256 + AES-256-GCM (the
   compatibility baseline for the Nomad's Chromium 109, subject to the spike),
   or use a maintained audited protocol library after an evaluation.
5. AuthGravity authenticates an account but does not by itself make a public
   device directory safe from active relay substitution. If the relay is in
   scope as an active adversary, device-directory updates and snapshots need an
   account-controlled signing key plus a trust/bootstrap mechanism (for
   example QR fingerprint verification, key transparency, or an explicitly
   documented TOFU trade-off). TLS alone protects transit, not a compromised
   server. Define this before calling the service E2EE against the server.
6. “Delete the old key when IndexedDB is deleted” must mean re-enroll and
   revoke the old *public device registration* after account authentication;
   never delete a server key merely because a client starts empty. Old messages
   cannot be recovered by the replacement device unless another existing device
   deliberately re-encrypts them.

## Data model and crypto wire format

### Identity and device directory

Server data, all keyed internally by AuthGravity `user_id`:

```ts
interface Account {
  userId: string;              // AuthGravity UUID
  username: string;            // unique, normalized, immutable for v1
  directoryVersion: number;
}

interface DeviceRecord {
  id: string;                  // random opaque ID, not the public key
  userId: string;
  label: string;
  platform: 'pwa' | 'supernote';
  encryptionPublicKeySpki: string; // base64url P-256 SPKI
  fingerprint: string;         // SHA-256(public key), displayable
  status: 'active' | 'revoked';
  createdAt: string;
  revokedAt?: string;
}
```

A directory response contains only active devices, its monotonically increasing
version, and (once chosen) a canonical signature and account signing public
key. Clients pin a recipient directory version while composing a message and
retry encryption if it changes before submission.

### Encrypted note record

Serialize the full page (`from`, page elements, display name, application
version, etc.) as plaintext. The service-visible record has no note body or
stroke/text metadata:

```ts
interface EncryptedNoteRecordV1 {
  version: 1;
  id: string;
  recipientUserId: string;
  recipientDirectoryVersion: number;
  ciphertext: string;          // base64url AES-256-GCM ciphertext + tag
  contentIv: string;           // base64url, 12 random bytes
  keySlots: Array<{
    deviceId: string;
    ephemeralPublicKeySpki: string;
    wrapIv: string;            // base64url, 12 random bytes
    wrappedContentKey: string; // AES-256-GCM wrapped 32-byte content key
  }>;
}
```

For each key slot, generate an ephemeral P-256 ECDH key pair, derive a wrapping
key with HKDF-SHA-256 from the ECDH secret, and AES-GCM-wrap the content key.
The HKDF salt/info and both AEAD AAD byte encodings are versioned constants in
one shared crypto module. Bind record ID, recipient user ID, directory version,
and device ID into AAD. Validate every decoded field and impose ciphertext,
slot-count, and plaintext-size limits before attempting cryptography.

Add a sender device signing key and canonical-record signature if recipients
must cryptographically verify sender identity rather than merely trust the
relay's account metadata. This is required for the stronger malicious-relay
threat model and should be designed with the signed directory, not bolted on
later.

## API and delivery changes

1. Add server middleware that forwards the incoming AuthGravity session cookie
   (PWA) or bearer session to AuthGravity `/v1/whoami`; cache neither identity
   nor authorization decisions. Configure production AuthGravity on a sibling
   subdomain of the WRTN registrable domain. Read that provisioned endpoint's
   `llms.txt` before implementation.
2. Replace `POST /v1/hello` anonymous registration and random bearer tokens
   with authenticated account endpoints:
   - `GET /v1/me`; `PUT /v1/me/username` (claim once; conflict is `409`).
   - `GET /v1/users/:username/devices` for a recipient's active directory.
   - `POST /v1/devices`, `DELETE /v1/devices/:id`, and a device-list endpoint,
     all authorized as the account owner and version/concurrency checked.
3. Store `EncryptedNoteRecordV1` unchanged. `POST /v1/notes` verifies only
   record shape, limits, sender authentication, and that its key slots exactly
   cover the active recipient directory version. It never receives plaintext
   page elements or content keys.
4. Change polling and acknowledgement to be **per device**: `POST
   /v1/devices/:id/poll` returns only records with a slot for that device;
   `POST /v1/devices/:id/acks` records a device acknowledgement. Retain a
   record until every device included at send time has acknowledged it, then
   expire by a documented retention policy. A newly added device does not gain
   old records automatically because it has no key slot.
5. Remove or restrict `/v1/peers` because it currently exposes users and
   mailbox counts. Keep `swaptest` development-only and make it produce an
   encrypted record through a test client, not server-readable pages.
6. Add persistent storage before treating delivery as hosted service: the
   current server registry and mailboxes are in-memory and lose messages on
   restart. Encrypt before persistence; database backups must contain only the
   opaque records, public directory, and delivery state.

## Client implementation

### PWA

1. Create a separate `packages/pwa` TypeScript PWA workspace with the compact
   scanner/send/inbox UI. Integrate AuthGravity register/login/logout and
   username claim. Do not use username as the AuthGravity account identifier.
2. On first authenticated use, generate non-extractable P-256 ECDH encryption
   and signing keys with WebCrypto and store `CryptoKey`s plus device metadata
   in IndexedDB. Persist the public key first, then register the device; make
   both steps recoverable and idempotent.
3. Fetch and display key fingerprints when selecting a recipient, encrypt the
   page locally, upload the opaque record, decrypt only the local key slot, and
   acknowledge only after successful local persistence/import.
4. Treat IndexedDB loss as device loss: show a re-enrollment screen, generate a
   new key pair, then revoke the stale registration from a valid AuthGravity
   session. Explain that unwrapped historical messages are unavailable.

### Supernote plugin and pairing

1. Perform a feasibility spike on the real Nomad before implementation:
   verify `globalThis.crypto.subtle` supports P-256 ECDH, HKDF, AES-GCM,
   `getRandomValues`, and an available storage mechanism can retain a
   non-exportable key across plugin restarts. The current React Native plugin
   cannot use browser IndexedDB. Record exact OS/runtime behavior and failure
   modes in this plan.
2. If the spike passes, implement the same crypto-record module in the plugin
   and an SDK-supported protected key store. If only a filesystem/`.note`
   store is available, stop: an extractable private key in MyStyle does not
   meet the issue's “never leaves the device” claim. Either add a reviewed
   native secure-storage capability or explicitly limit the plugin feature to
   transport without E2EE.
3. For pairing, the new Supernote generates its device key and a 128-bit
   one-time pairing secret locally, displays a short code/QR plus a key
   fingerprint, and posts only a hash of the pairing secret with a short TTL.
   An already AuthGravity-authenticated PWA scans/types the secret, verifies
   the fingerprint out of band, and authorizes the pending device registration.
   Consume the pairing request once; rate-limit it and erase it on expiry or
   completion. The Supernote receives a scoped, one-time enrollment result,
   not a reusable browser session.
4. Keep the present `.note` configuration only for non-secret relay settings;
   migrate the anonymous generated username and HTTP token flow away.

## Implementation sequence

1. Write a threat model and decide whether the relay is honest-but-curious or
   malicious. Specify directory signing/trust and sender authentication before
   writing crypto.
2. Build `@wrtn/crypto` as a browser-compatible shared workspace. Add known
   answer tests for encoding/KDF/AAD plus round-trip, wrong-device, tampering,
   IV uniqueness, and malformed-record tests. Independently cross-check test
   vectors with a second WebCrypto implementation.
3. Add database migrations/repository interfaces for accounts, device
   directories, encrypted records, acknowledgements, pairing requests, and
   retention. Implement authenticated server APIs and remove anonymous
   `/v1/hello`/token authorization behind an API version boundary.
4. Build the PWA account, directory, device-key, encryption, send, poll, and
   revoke flows. Test with two browser profiles and IndexedDB deletion.
5. Execute the Supernote crypto/storage spike. Implement QR/code pairing and
   encrypted plugin delivery only if the chosen storage and crypto primitives
   pass on-device.
6. Migrate existing test fixtures and current plugin protocol only after the
   encrypted transport is interoperable. Existing plaintext relay mailboxes
   should be drained or discarded with a clearly announced cutover; do not
   silently mix plaintext and encrypted records.
7. Run security review, dependency/license review, abuse/rate-limit tests, and
   a two-PWA plus PWA-to-Nomad on-device end-to-end test. Include a relay
   database inspection proving page content is not present.

## Acceptance checks

- An unauthenticated caller cannot claim a username, enroll/revoke devices, or
  send/poll records.
- Two devices under one account each receive and decrypt the same note; one
  device's acknowledgement never removes the other's delivery.
- Database, logs, peer/debug endpoints, and wire capture contain no plaintext
  strokes, text, or content keys.
- Changing any ciphertext, IV, key slot, AAD-bound field, or directory version
  makes decryption fail closed.
- Revoked devices receive no newly created slots; a newly paired device cannot
  decrypt earlier records unless an existing device explicitly re-encrypts
  them.
- A Supernote can be paired from an authenticated phone/laptop without a
  passkey, and the actual device implementation has passed the crypto/key
  persistence spike.
