# Encrypted whole-note prototype API

`WrtnServer` currently serves the legacy page relay and this separate,
in-memory encrypted-note spike. Only the `/v1/prototype/*` endpoints are for
the new architecture. They have **no authentication or persistence** and must
be bound to a development-only network.

## Flow

1. The client creates a P-256 device key and registers its public SPKI:
   `POST /v1/prototype/devices` with `{ userId, deviceId, publicKeySpki }`.
2. Fetch the recipient directory with
   `GET /v1/prototype/devices/:userId`.
3. Locally create an `EncryptedNoteRecordV1`: AES-256-GCM encrypts the entire
   note payload and P-256 ECDH/HKDF wraps the content key once for every device
   in that exact directory snapshot.
4. Upload it as `POST /v1/prototype/notes` with `{ record }`.
5. Poll `{ deviceId }` at `/v1/prototype/poll`, decrypt locally, then submit
   `{ deviceId, recordIds }` to `/v1/prototype/ack`.

The relay validates that slots exactly match the current destination directory,
then stores/delivers opaque ciphertext per recipient device. It sees user and
device routing IDs, directory version, encrypted record size, and delivery
state—not filename or `.note` bytes.

## `echo` test user

The server creates an `echo` directory containing one fixed process-local test
device. A record addressed to `echo` is decrypted by that test device and the
same full-note payload is newly encrypted back to every registered sender
device. This exercises both client encryption/decryption directions without
letting normal relay delivery inspect plaintext.

`echo` is intentionally not end-to-end private from the prototype server: its
private key is in the server process. It is unauthenticated, ephemeral, and for
fixtures only. Never send sensitive notes to it and remove/isolate it before a
hosted deployment.
