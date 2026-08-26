# Encrypted whole-note service

`OlainkServer` serves the encrypted-note pairing and delivery API. It persists
opaque device directories, encrypted records, delivery acknowledgements,
single-use pairing codes, and immutable public username assignments. It never
stores ordinary note plaintext, filenames, or client private keys.

## Build and run

Bun compiles the server and its onboarding page into one Linux executable; the
deployment host does not need Node or Bun at runtime:

```sh
npm run build:server              # Linux x86_64: dist/olaink-server
npm run build:server:arm64        # Linux aarch64: dist/olaink-server-linux-arm64
install -Dm755 dist/olaink-server /opt/olaink/olaink-server
install -d -m 0700 /var/lib/olaink

# Defaults to https://authgravity.app.olaink.com/v1/whoami; override only for a test pool.
/opt/olaink/olaink-server --host 127.0.0.1 --port 8002 \
  --database /var/lib/olaink/olaink.sqlite
```

`GET /commit` returns the full Git commit embedded when the executable was
built (plain text, no cache), so a deployed binary can be identified without
access to its source checkout.

The server defaults to `0.0.0.0:8002`. Its default SQLite path is
`./olaink.sqlite`; set `--database PATH` or `OLAINK_DATABASE=PATH` to put data
on a persistent volume. SQLite WAL mode is enabled, so back up the database
using SQLite's backup mechanism or while the service is stopped (include the
`-wal` and `-shm` sidecars for a filesystem-level live copy). Graceful `SIGINT`
and `SIGTERM` close the database. Backups and restores must include the
`account_usernames` table: losing its active rows or retirement tombstones can
violate the permanent-name promise.

Terminate TLS and set forwarding/proxy policy in front of this HTTP process.
Do not expose the port directly on the public Internet. The in-memory
per-source pairing rate limit is not proxy-aware or durable; retain an
edge-level rate limit for `POST /v1/pairings/claim`.

## Flow

1. An authenticated client obtains its opaque account state from
   `GET /v1/account` and claims its one permanent public address through
   `POST /v1/account/username`.
2. A signed-in sender resolves a recipient's active address through
   `GET /v1/users/:username`; the opaque directory ID is used only inside the
   encrypted-record operation.
3. A named account enrolls a browser receiver through `POST /v1/devices`.
   The browser creates a non-extractable P-256 key in IndexedDB; only its SPKI
   is registered.
4. A sender locally creates an `EncryptedNoteRecordV1`: AES-256-GCM encrypts
   the complete note payload and P-256 ECDH/HKDF wraps the content key once for
   every device in that exact directory snapshot. It uploads `{ username,
   record }` to `POST /v1/notes`.
5. The enrolled recipient polls `/v1/poll`, decrypts and checks the encrypted
   metadata, SHA-256, local IndexedDB persistence, and pinned viewer load, then
   acknowledges through `/v1/ack`. All three operations require the
   AuthGravity account that owns the device.

The relay validates that slots exactly match the current destination directory,
then stores and delivers opaque ciphertext per recipient device. It sees user
and device routing IDs, directory version, encrypted record size, and delivery
state—not filename or `.note` bytes.

## Hosted endpoint

The canonical Ola Ink service origin is `https://app.olaink.com`. Terminate TLS
for that hostname in front of this HTTP process and run the process with
`OLAINK_PORT` (and, where appropriate, `OLAINK_HOST`). The companion defaults
to this origin. The production AuthGravity endpoint is
`https://authgravity.app.olaink.com` (the verifier calls `/v1/whoami`). Serve
laptop login and companion setup at `https://app.olaink.com/`; AuthGravity must
be configured with an RP ID of `app.olaink.com` or `olaink.com`, rather than
`localhost`.

## AuthGravity pairing-code service

`POST /v1/pairings` enrolls an authenticated primary device only
after the account has claimed a username, then returns a one-time, 10-minute
eight-digit code displayed as `1234-5678`.
Configure the AuthGravity pool endpoint with `AUTHGRAVITY_WHOAMI_URL`. Ola Ink
is an AuthGravity client: it forwards the caller's `session_id` cookie (or a
bearer session ID for non-browser clients) to that pool's `GET /v1/whoami`, and
uses only its documented `{ user_id }` response. It neither implements login
nor issues, stores, or exposes AuthGravity credentials.

`POST /v1/pairings/claim` consumes a code and adds the presented
public key to the same account directory. The server permits CORS for this
one unauthenticated, code-capability operation only from Android
WebViewAssetLoader's fixed `https://appassets.androidplatform.net` origin;
account/device APIs remain same-origin. The AuthGravity subject is replaced
with a random opaque `account_*` routing ID, so it is not exposed to recipients.
SQLite retains the opaque account mapping, permanent username ownership ledger,
and unexpired, single-use codes across restarts. Usernames cannot be renamed,
transferred, or reused. Retired accounts leave a minimal tombstone so the name
stays unavailable; see [`docs/account-policy.md`](../../docs/account-policy.md).

The public HTTP boundary is account/device-bound: a caller cannot register a
key, poll, acknowledge, or send from a device owned by another account. A raw
recipient account ID is not accepted as a destination parameter; sends resolve
and submit an immutable username. Durable proxy-aware rate limits, retention
expiry, audit events, and device revocation remain required before production
rollout.

## Browser inbox data and loss

The root page serves a self-hosted pinned Supernote viewer and browser inbox.
It persists only original encrypted records plus local read/received state in
IndexedDB. Decrypted filenames, sender labels, and `.note` bytes are held in
memory for the list/viewer and are not written to localStorage, URLs, or relay
storage. Clearing site data destroys the non-extractable private key: a newly
enrolled browser can receive future notes but cannot decrypt deliveries sent
only to the lost device.
