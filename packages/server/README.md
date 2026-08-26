# Encrypted whole-note prototype API

`OlainkServer` currently serves the legacy page relay and this separate,
encrypted-note prototype. Only the `/v1/prototype/*` endpoints are for the new
architecture. The deployable Bun binary persists prototype device directories,
opaque encrypted deliveries, AuthGravity-to-opaque-account mappings, and
single-use pairing codes in SQLite. The legacy `/v1/hello`, `/v1/send`, and
`/v1/poll` page relay remains an in-memory compatibility surface.

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

The server defaults to `0.0.0.0:8002`. Its default SQLite path is
`./olaink.sqlite`; set `--database PATH` or `OLAINK_DATABASE=PATH` to put data
on a persistent volume. SQLite WAL mode is enabled, so back up the database
using SQLite's backup mechanism or while the service is stopped (include the
`-wal` and `-shm` sidecars for a filesystem-level live copy). Graceful `SIGINT`
and `SIGTERM` close the database.

Terminate TLS and set forwarding/proxy policy in front of this HTTP process.
Do not expose the port directly on the public Internet. The in-memory
per-source pairing rate limit is not proxy-aware or durable; retain an
edge-level rate limit for `POST /v1/prototype/pairings/claim`.

The SQLite database contains routing metadata, public device keys, opaque
ciphertext records awaiting acknowledgement, pairing codes until used/expired,
and the **test-only echo** private key. It never contains ordinary note
plaintext, filenames, or client private keys. Acknowledging a record removes
its delivery rows and deletes the ciphertext once every recipient has
acknowledged it.

This remains a prototype, not a production authorization design: direct device
registration, note upload, polling, and acknowledgement are still authorized
only by public routing/device IDs. Deploy the AuthGravity pairing flow rather
than the direct registration route, and add device-bound authorization before
using the relay for real accounts.

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

## Hosted endpoint

The canonical Ola Ink service origin is `https://app.olaink.com`. Terminate TLS
for that hostname in front of this HTTP process and run the process with
`OLAINK_PORT` (and, where appropriate, `OLAINK_HOST`). The companion defaults
to this origin. The production AuthGravity endpoint is
`https://authgravity.app.olaink.com` (the verifier calls `/v1/whoami`). Serve
laptop passkey onboarding at `https://app.olaink.com/prototype/onboard`;
AuthGravity must be configured with
an RP ID of `app.olaink.com` or `olaink.com`, rather than `localhost`.

## AuthGravity pair-code prototype

`POST /v1/prototype/pairings` enrolls an authenticated primary device and
returns a one-time, 10-minute eight-digit code displayed as `1234-5678`. Configure the AuthGravity pool endpoint with `AUTHGRAVITY_WHOAMI_URL`. Ola Ink is an
AuthGravity client: it forwards the caller's `session_id` cookie (or a bearer
session ID for non-browser clients) to that pool's `GET /v1/whoami`, and uses
only its documented `{ user_id }` response. It neither implements login nor
issues, stores, or exposes AuthGravity credentials.

`POST /v1/prototype/pairings/claim` accepts `{ code, device: { deviceId,
publicKeySpki } }`, consumes the code, and adds that public key to the same
account directory. The AuthGravity subject is replaced with a random opaque
`account_*` routing ID, so it is not exposed to recipients. SQLite retains the opaque account mapping and unexpired, single-use codes
across restarts. Pair-code claims are still capped at 10 attempts per source IP
per minute in this process; production needs durable, proxy-aware rate limiting,
a confirmation step, and replay/audit protections before relying on an
eight-digit code.

### Local passkey test

In one terminal, start AuthGravity's documented local proxy:

```sh
npx @authgravity/cli listen
```

Then start Ola Ink in another terminal and open the primary-device page in a
passkey-capable laptop browser:

```sh
AUTHGRAVITY_WHOAMI_URL=http://localhost:8787/v1/whoami OLAINK_PORT=8002 npm run server
# open http://localhost:8002/prototype/onboard
```

The AuthGravity session cookie is scoped to `localhost` (not a port), so Ola Ink
forwards it to the local proxy to validate `POST /v1/prototype/pairings`. Use
the displayed code in the Supernote companion's **Pair this companion with
code** control. The companion never signs in to AuthGravity and never receives
the session cookie.

### Tailnet passkey test

AuthGravity CLI versions that provide `--rp-id` can mint a Tailnet test
sandbox with an RP ID matching the browser origin. Bind the proxy to the
Tailnet name and set that exact RP ID (or its registrable parent):

```sh
npx @authgravity/cli@0.0.9 listen \
  --host macmini.rhino-dragon.ts.net \
  --rp-id macmini.rhino-dragon.ts.net
```

The CLI proxy is plain HTTP on port 8787, so terminate Tailnet TLS on a second
port rather than fetching it directly from the HTTPS pairing page:

```sh
TAIL_IP="$(tailscale ip -4)"
tailscale serve --https=8444 --bg "http://${TAIL_IP}:8787"
AUTHGRAVITY_WHOAMI_URL=https://macmini.rhino-dragon.ts.net:8444/v1/whoami \
  OLAINK_PORT=8002 npm run server
```

Open the Ola Ink primary page through its existing HTTPS listener and set its
AuthGravity endpoint to `https://macmini.rhino-dragon.ts.net:8444`. Before
registering, verify that `/v1/register/options` reports the intended `rp.id`,
not `localhost`. The httpOnly `session_id` cookie is host-scoped (not
port-scoped), so it is sent to Ola Ink and Ola Ink forwards it to AuthGravity for
`/v1/whoami` validation.

## `echo` test user

The server creates an `echo` directory containing one fixed test device. In
the SQLite deployment its test private key is retained so restart does not
break the echo directory. A record addressed to `echo` is decrypted by that test device and the
same full-note payload is newly encrypted back to every registered sender
device. This exercises both client encryption/decryption directions without
letting normal relay delivery inspect plaintext.

`echo` is intentionally not end-to-end private from the prototype server: its
private key is in server storage. It is unauthenticated and for fixtures only. Never send sensitive notes to it and remove/isolate it before a
hosted deployment.
