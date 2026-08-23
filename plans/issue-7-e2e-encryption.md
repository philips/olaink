# Issue #7 — usernames and TOFU end-to-end encryption

Issue: <https://github.com/philips/wrtn/issues/7>

## Goal

Ensure that the relay only receives routing metadata and ciphertext: it must
never receive plaintext page strokes or text. Give people a stable, chosen
username, and use trust-on-first-use (TOFU) to detect a changed peer key on
later contact.

This is deliberately a one-device-per-username first version. It does not try
to provide group messaging, key recovery, multi-device sync, or a full
Signal-style ratchet.

## Investigation findings

### Current exposure

`page.send` currently contains `to` and `elements` in plaintext
(`packages/protocol/src/messages.ts`). The HTTP relay validates, routes,
queues, and logs those envelopes. In particular, `handlePoll()` logs whole
batches, so it logs page strokes/text today. TLS protects the network hop only;
it does not protect data from the relay.

The current username is a generated value stored in the plugin's `.note`
configuration. `/v1/hello` accepts any valid username and rotates that user's
session token. There is no durable account directory, public-key binding, or
proof that a reconnecting device owns a name. That is incompatible with both
chosen usernames and TOFU identity.

The plugin has no cryptography dependency and the public Supernote SDK exposes
no crypto/keystore/random-byte module. The existing protocol explicitly uses
`Math.random` because the deployed Hermes runtime lacked
`crypto.getRandomValues`. `Math.random` is not acceptable for private keys,
nonces, or ephemeral keys. A secure entropy source is therefore a release
blocker, not an implementation detail.

## Security model and explicit limits

- The server learns usernames, sender/recipient relationship, message timing,
  ciphertext size, page count, acknowledgements, and IP/Tailscale-level
  metadata. It can delay, drop, replay, or reorder ciphertext.
- It cannot read or alter an accepted page after a peer key has been trusted.
- On the *first* contact, an active malicious relay can substitute a key. TOFU
  records that first key; users who need protection at first contact must
  compare a displayed fingerprint out of band.
- The proposed sealed-page design does not provide post-compromise security or
  receiver forward secrecy. A later compromise of the recipient's private key
  can decrypt captured old ciphertext. Do not describe it as Signal protocol
  encryption.
- Device configuration is currently a readable `.note` file, not an Android
  hardware-backed keystore. The goal is relay confidentiality, not protection
  from someone who can read the recipient's storage. There is no key recovery:
  losing that file/device loses the identity.

## Proposed v1 design

### 1. Establish safe client cryptography first

1. On the target Nomad, log/probe whether `globalThis.crypto.getRandomValues`
   is available in the actual plugin-host Hermes runtime.
2. If it is available, use it through a small `RandomSource` adapter that
   rejects missing/failing secure randomness. If it is not, obtain a Ratta
   supported native secure-random API or add a supported native module to the
   host. **Do not fall back to `Math.random`.**
3. Add a small, audited pure-JS implementation compatible with the plugin
   bundle (for example TweetNaCl): Ed25519 signatures plus X25519/XSalsa20-
   Poly1305 `box`. Pin and audit its version/licence; inject the secure random
   adapter rather than relying on an implicit browser global.
4. Centralize base64url encoding, UTF-8 conversion, fixed-width packet
   serialization, fingerprint calculation, and payload-size limits in a new
   protocol crypto module. Test against known vectors.

### 2. Persistent user identity and discovery directory

Create and persist two keypairs with the existing config, never uploading a
private key:

- Ed25519 signing identity (public key identifies the user);
- X25519 encryption identity (public key receives pages).

The server gets a durable, atomically written directory record:

```
username -> { signingPublicKey, encryptionPublicKey, keyVersion, createdAt }
```

Add explicit registration and lookup endpoints. A client lets the person type a
valid username, generates keys before first registration, and atomically claims
that name with its two public keys. A collision is an error and keeps the
chosen value editable; it must never silently generate a replacement name.
Existing generated names can be offered as a migration default, but need a
one-time claim.

Replace unauthenticated `/v1/hello` with a server challenge signed by the
stored Ed25519 key. The server verifies the challenge response before issuing
the short-lived HTTP poll token. The token continues to authorize send/poll,
but no unauthenticated caller can take over a registered username. The
identity directory must survive server restart; the current in-memory
`Registry` is not sufficient. Define a small file-backed durable store with
atomic rename (or introduce a real database) before exposing registration.

Lookup returns only the public directory record. Cache it only as a hint;
clients must validate it against their local trusted-contact record.

### 3. Encrypt and authenticate `page.send`

Keep the outer envelope and `to` field so the relay can route and retain pages,
but replace plaintext `elements` with an encrypted packet:

```
{
  to,
  senderSigningKey,
  senderEphemeralEncryptionKey,
  nonce,
  ciphertext,
  signature,
  pageId
}
```

For each page the sender:

1. Looks up the recipient's X25519 and Ed25519 public keys.
2. Generates a fresh X25519 ephemeral keypair and 24-byte nonce using the
   verified secure random source.
3. UTF-8 encodes a canonical plaintext containing protocol version, `pageId`,
   sender username, recipient username, and all page elements.
4. Encrypts it with `nacl.box` to the recipient's X25519 public key.
5. Signs a length-prefixed canonical encoding of every outer routing/crypto
   field (`to`, `pageId`, sender public keys, ephemeral public key, nonce, and
   ciphertext) using the sender's Ed25519 key.

The receiver uses the server directory/public packet to identify the signing
key, verifies the signature before decryption, decrypts, and checks that the
inner sender, recipient, and `pageId` agree with the outer packet. It then
hands only validated plaintext elements to the existing queue/append path.
`pageId`, rather than a server-created envelope id, is the authenticated
identity used for deduplication and `pages.ack`. Acknowledgements remain
plaintext metadata because the relay needs them to delete ciphertext.

Reject malformed/oversized base64 fields before attempting crypto. The relay
only structurally validates the encrypted packet and never parses page
contents. Remove whole-envelope debug logging and ensure error messages never
include decrypted data. `swaptest` cannot emit a normal encrypted page without
a bot private key; keep it development-only with an explicit test identity, or
replace its coverage with two test clients and disable it in production.

### 4. TOFU UI and key changes

Extend stored config with trusted contacts keyed by username and signing-key
fingerprint (plus the paired encryption key/version). On a valid first page
from an unknown user, show it in the fullscreen inbox as **Trust
<username>** and show a short fingerprint. Do not append or acknowledge it
until the person accepts. On later contact:

- matching trusted key: decrypt and queue normally;
- a different key/version: mark the page blocked and show a conspicuous
  changed-key warning; never silently replace trust;
- explicit "forget/retrust" requires confirmation and documents that a
  malicious first key cannot be distinguished from a legitimate rotation.

The configuration view needs a username claim/change flow, local fingerprint,
and a trusted-contact list/revoke action. A v1 username/key change abandons
access to messages encrypted to the previous private key.

## Implementation sequence

1. **Device feasibility gate:** prove a supported CSPRNG exists in the deployed
   plugin host. Stop if it does not; request an SDK/host capability rather than
   shipping weak cryptography.
2. Add crypto codec/key models and deterministic test vectors; add config
   migration that preserves current server URL and generated username.
3. Add durable server identity directory, register/lookup/challenge endpoints,
   and replace hello authentication. Cover claim conflict, restart persistence,
   challenge replay, and token takeover tests.
4. Change protocol guards/router/mailbox to accept only encrypted page packets;
   remove plaintext logging and revise/disable `swaptest` for production.
5. Add client lookup, encryption, signature verification, decryption,
   authenticated page IDs, replay handling, and TOFU persistence/UI.
6. Test two plugin cores exchanging pages through the HTTP server. Assert that
   every server-visible body/log contains ciphertext but no stroke/text values;
   test wrong recipient, bad signature, nonce/key corruption, TOFU first trust,
   key substitution warning, redelivery, and acknowledgements.
7. Build/deploy to two Supernotes and manually validate claim, first-contact
   fingerprint, offline delivery, appending after trust, restart persistence,
   and changed-key refusal.

## Acceptance criteria

- No server request, mailbox record, response, or server log contains a page's
  stroke coordinates, text, or decoded elements.
- A registered username cannot be claimed or polled by a caller lacking its
  private signing key, including after server restart.
- Recipient lookup discovers a chosen username and its public identity keys.
- First contact requires an explicit TOFU trust decision; a later key change
  blocks delivery until explicitly reviewed.
- Valid trusted peers can exchange an offline page, append it once, and ack the
  ciphertext mailbox record without exposing plaintext to the relay.
- The release path fails closed if cryptographically secure randomness is not
  available on the Supernote runtime.
