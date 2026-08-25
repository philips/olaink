# Ola Ink PWA and Android companion

The Ola Ink PWA is the product client. It runs in a phone/laptop browser and in
the Ola Ink Android companion's WebView on Supernote.

## Responsibilities

- Authenticate with AuthGravity. The companion WebView has no assumed passkey
  support, so it is enrolled from a passkey-capable device with a short-lived
  pairing flow or uses AuthGravity's account-key fallback. The current spike
  has an AuthGravity `/v1/whoami` adapter plus an in-memory, single-use,
  10-minute pair code: an authenticated primary device enrolls its public key,
  shows a one-use eight-digit code formatted as `1234-5678`, and the companion
  consumes that code to add its own public key. It is not production authentication until the provider
  claims/schema, persistence, confirmation, and rate limits are reviewed.
- Create and retain non-extractable per-device WebCrypto keys in IndexedDB.
- Fetch recipient device directories; encrypt/decrypt complete `.note` file
  `ArrayBuffer`s; upload/download opaque records; poll and acknowledge per
  device.
- Display decrypted notes through the pinned `<supernote-viewer>` component in
  `write-on-paused` mode. The component supplies the Play/replay UI.

The PWA does not extract or reconstruct page elements. A `.note` file is the
only message body.

## Android wrapper

The native APK provides a stable WebView profile, intent entry point, tightly
scoped source-file access, and return-to-Supernote navigation. It is not the
crypto client: it exposes a selected `.note` only to the pinned/allowlisted PWA
origin, while all cryptography and service interactions happen in WebView JS.

`android` validates the Nomad intent launch and the
pinned viewer under Chromium 109. Production still needs a safe current-note
`content://`/Storage Access Framework hand-off; an intent path string or file
bytes are not an acceptable replacement.

See [`issue-15-e2ee-note-service.md`](issue-15-e2ee-note-service.md) for the
record format, pairing flow, and migration plan.
