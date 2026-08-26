# Issue #15 — encrypted whole-note exchange

Issue: <https://github.com/philips/olaink/issues/15>

## Decision

Ola Ink has two Android surfaces:

1. The **Supernote plugin** is a small in-note **Share** affordance. It obtains
   only enough context to hand the active `.note` to the companion and launches
   that installed Android application. It does no login, polling, encryption,
   stroke extraction, page reconstruction, or inbox append.
2. The **Ola Ink Android application** is the account-owning client. It is a thin
   native WebView wrapper around the Ola Ink PWA. The PWA authenticates, keeps its
   per-device keys in the WebView's IndexedDB, reads/decrypts/encrypts complete
   `.note` bytes, exchanges opaque ciphertext with the service, and displays a
   decrypted note with the pinned `<supernote-viewer>` component.

The network unit is one immutable encrypted `.note` file, never an extracted
page/stroke/text payload. The relay stores and delivers ciphertext only.

## Evidence already established

`android` is retained as a reproducible Nomad fixture:

- A Supernote PluginHost React Native `Linking.sendIntent()` call successfully
  launched an installed exported activity using a custom action with a scalar
  extra on Android 11. The retained fixture now uses `dev.olaink.OPEN_SHARE`.
- The wrapper's System WebView is Chromium 109 and runs the pinned
  `<supernote-viewer>` bundle. A real `.note` fixture loads as
  `write-on-paused`, and its native Play control replays ink on the Nomad.
- `WebViewAssetLoader` gives bundled assets an HTTPS origin, which is required
  for ES modules/workers and avoids `file://`.

This proves intent launch and local playback, **not** transfer of the current
open Supernote file. The plugin SDK cannot read note bytes, and the validated
intent carries scalar extras only. The source-file hand-off described below is
a release gate.

## Product flow

```text
Supernote note view
  └─ Ola Ink Share ── Android intent (opaque draft/source handle only) ──▶ Ola Ink APK
                                                                       └─ WebView PWA
                                                                          ├─ obtain full .note bytes
                                                                          ├─ select recipient/device keys
                                                                          ├─ encrypt and upload ciphertext
                                                                          └─ return-to-Supernote button

Ola Ink APK / WebView PWA
  └─ authenticated poll ──▶ ciphertext blob ──▶ decrypt ArrayBuffer
                                                ──▶ <supernote-viewer>.noteData
                                                     (write-on-paused; user presses Play)
```

The companion's completion screen returns the user to the Supernote note
activity with Android task/back navigation. No secret, authenticated URL,
plaintext note bytes, or reusable bearer token appears in an intent, URL, or
log.

## Security and account model

- AuthGravity authenticates the person on phone/laptop with a passkey. The
  wrapper WebView is enrolled through that authenticated device (QR/short,
  single-use pairing) or AuthGravity's account-key fallback; it must not depend
  on a Nomad passkey.
- The PWA creates a distinct non-extractable P-256 ECDH device key and a
  signing key in IndexedDB. The public keys are registered in the account's
  device directory. Losing WebView data is device loss: enroll a replacement
  key, then revoke the old registration. It cannot recover ciphertext for
  which it had the only key slot.
- Encrypt every file locally with a new random AES-256-GCM content key and
  96-bit IV. Wrap that key for **each active recipient device** with ephemeral
  P-256 ECDH, HKDF-SHA-256, and AES-256-GCM. The recipient, record ID,
  device ID, directory version, and format version are authenticated data.
- The encrypted plaintext contains filename, MIME/type, original size and hash,
  sender display data, and the raw `.note` bytes. The relay sees only account
  and device routing metadata, ciphertext size, timing, and acknowledgements.
- Use a signed device directory plus QR fingerprint confirmation (or explicitly
  document TOFU) before claiming protection from a malicious relay. AuthGravity
  identity alone does not prevent a hostile directory from substituting a
  recipient key.
- Do not use `e2ee.js` unchanged: its documented AES-CTR construction does not
  provide the required AEAD record format. Put the exact KDF/AAD encodings and
  test vectors in a small shared WebCrypto module.

## Service model

Replace anonymous usernames/tokens, JSON page envelopes, and in-memory page
mailboxes with persistent authenticated accounts, device directories, opaque
note records, and per-device delivery state.

```ts
interface EncryptedNoteRecordV1 {
  version: 1;
  id: string;
  recipientUserId: string;
  recipientDirectoryVersion: number;
  ciphertext: string; // opaque binary/blob reference; AES-GCM ciphertext + tag
  contentIv: string;  // 12 random bytes, base64url
  keySlots: Array<{
    deviceId: string;
    ephemeralPublicKeySpki: string;
    wrapIv: string;
    wrappedContentKey: string;
  }>;
}
```

Required API shape:

- Authenticated account/username and device-directory APIs. AuthGravity
  `/v1/whoami` is checked for every account/device mutation.
- `POST /v1/notes` accepts a validated opaque record/blob and requires slots
  for exactly the recipient directory snapshot. It never accepts `.note` bytes
  or page elements in plaintext.
- Per-device poll and acknowledgement endpoints return only records containing
  that device's slot. Acknowledge only after decrypt, integrity validation, and
  successful viewer load/local persistence. Acknowledging on one device never
  removes delivery for another.
- Retain the ciphertext until all devices addressed at send time acknowledge or
  the documented retention period ends. New devices do not get old messages
  automatically; an existing device must deliberately re-encrypt them.
- Use durable storage before hosted rollout. Database/blob backups contain
  public device records, routing state, and ciphertext only. Restrict diagnostic
  endpoints to the authenticated operational surface.

### Development echo recipient

The in-memory prototype exposes an `echo` user with one fixed public device
key. It is a deliberately server-resident **test client**, not relay behavior:
it decrypts only records addressed to `echo`, then creates a fresh encrypted
record for every active sender device. This gives the PWA/companion an
end-to-end send → decrypt → re-encrypt → decrypt test without allowing the
relay to read ordinary recipient records. Its private key is in the prototype
process, registration/API calls are unauthenticated, and its directory is not
trusted; never send sensitive notes to `echo`. Delete or isolate it before any
hosted deployment.

## Supernote share hand-off

The share plugin is deliberately not a second client. It registers a Share
button in the note view, determines the active note identity, and starts the
wrapper's explicit custom action. The wrapper has an exported `singleTop`
activity and validates all intent fields.

The implementation must choose and prove one safe way for the wrapper to get
*the complete active file*:

1. Preferred: an Android `content://` URI with a temporary read grant, supplied
   by a supported Supernote/PluginHost sharing API.
2. Otherwise: a user-mediated Storage Access Framework selection or a narrowly
   scoped native companion bridge that obtains approved bytes from Supernote.

A bare filesystem path extra, unrestricted shared-storage permission, copying
bytes through the intent, or a plugin-generated base64 payload is not
acceptable in the production protocol. `Linking.sendIntent()` alone cannot add
URI grant flags, so option 1 may require a PluginHost API/native bridge. Until
the device test proves this boundary, the production share button may open the
wrapper but must not claim it sends the current note.

Once the native wrapper has the selected bytes, it exposes them only to its
pinned PWA origin (for example via a one-shot native bridge or an
`WebViewAssetLoader` opaque draft URL). The WebView reads the bytes as an
`ArrayBuffer`; all recipient lookup, encryption, upload, progress, and error
handling remains PWA JavaScript. The native shell must disable file/content
access, block untrusted navigation, enforce an allowlist for bridge calls, and
never inject source bytes into a remote/untrusted origin.

## Android PWA and player

- Keep the production PWA/browser-first. Package the exact PWA bundle in, or
  serve it from, an allowlisted first-party HTTPS origin in the wrapper. Use a
  stable WebView profile so IndexedDB keys survive app restarts.
- Bundle and self-host the pinned `<supernote-viewer>` assets through
  `WebViewAssetLoader`; retain the update script, upstream commit, checksums,
  and E-Ink 10 FPS patch in `android`.
- On receive, fetch an opaque record, pick the local key slot, decrypt to an
  `ArrayBuffer`, verify the encrypted inner metadata/hash, then set
  `viewer.presentation = 'write-on-paused'` before `viewer.noteData = bytes`.
  The component supplies Play/replay/speed controls. Do not write a second
  stroke animator.
- A parse/playback failure leaves the ciphertext unacknowledged and retryable.
  Offer the viewer's static presentation as a fallback for notes without
  animatable vector ink.

## Migration

1. Write the threat model and directory-signing/bootstrap decision. Build a
   shared browser-compatible crypto package with independent test vectors,
   tampering/wrong-device tests, IV checks, and strict decoding/size limits.
2. Build the persistent authenticated server and whole-note opaque-record API.
   Add multi-device polling, acknowledgement, expiry, and blob lifecycle tests.
3. Build the PWA account, pairing, device-key, compose, inbox, decryption, and
   viewer flow. Test two browser/WebView profiles and IndexedDB loss.
4. Turn the retained wrapper fixture into the production shell and complete the
   source-file hand-off spike on a real Nomad. Test intent resolution, URI
   permission lifetime, return navigation, and no leakage in logcat.
5. `packages/plugin` is reduced to the in-note Share affordance. It has no
   server configuration, account state, polling, inbox, auto-append, page
   geometry, element serialization/insertion, or stroke/text extraction.
6. The plaintext relay, its protocol workspace, fixtures, and test paths have
   been deleted. Do not mix plaintext records with encrypted whole-note
   records.

## Acceptance checks

- Tapping Share in an open Nomad note reaches the wrapper and, after a verified
  source-file hand-off, sends exactly that full `.note` file; no strokes are
  extracted or reconstructed.
- The wrapper can return to the originating Supernote task after send/cancel.
- A relay/database/wire capture has no filename, note bytes, strokes, text, or
  content key in plaintext.
- Two recipient devices each decrypt the same file; one acknowledgement does
  not consume the other device's copy.
- The wrapper decrypts a received fixture and `<supernote-viewer>` replays it
  with its native Play control on the actual Nomad.
- A missing/invalid companion, malformed intent, unavailable source grant,
  failed decrypt, or failed viewer load fails closed with actionable UI and no
  acknowledgement.
