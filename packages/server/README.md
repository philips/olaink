# Encrypted whole-note service

`OlainkApp` (`src/handler.ts`) serves the encrypted-note pairing and delivery
API as one fetch-style handler. The same handler runs as a Cloudflare Worker
(`src/worker.ts`, D1 + R2) and as the self-hosted binary (`src/main.ts` →
`src/standalone.ts`, `Bun.serve` over local SQLite + a payload directory). It
persists opaque device directories, encrypted records, delivery
acknowledgements, single-use pairing codes, and immutable public username
assignments. It never stores ordinary note plaintext, filenames, or client
private keys.

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
  --database /var/lib/olaink/olaink.sqlite \
  --notes /var/lib/olaink/notes
```

`GET /commit` returns the full Git commit embedded when the executable was
built (plain text, no cache), so a deployed binary can be identified without
access to its source checkout.

The server defaults to `0.0.0.0:8002`. It always uses SQLite, with
`./olaink.sqlite` as its default path; set `--database PATH` or
`OLAINK_DATABASE=PATH` to place that required database on a persistent,
writable volume. The schema is the D1 schema in `migrations/`, embedded in the
binary and applied on startup (tracked in `d1_migrations`, like
`wrangler d1 migrations apply`). Encrypted note payloads are stored one file
per record in `--notes DIR` / `OLAINK_NOTES_DIR` (default
`<database>-notes`). There is no in-memory server mode. SQLite WAL mode is
enabled, so back up the database using SQLite's backup mechanism or while the
service is stopped (include the `-wal` and `-shm` sidecars for a
filesystem-level live copy), together with the notes directory. Graceful
`SIGINT` and `SIGTERM` close the database. Backups and restores must include
the `account_usernames` table: losing its active rows or retirement
tombstones can violate the permanent-name promise.

Terminate TLS and set forwarding/proxy policy in front of this HTTP process.
Do not expose the port directly on the public Internet. The pairing-claim rate
limit (10 per 60 s) is a durable SQLite counter keyed on the socket address, so
behind a reverse proxy every client shares the proxy's bucket; retain an
edge-level rate limit for `POST /v1/pairings/claim`. (The Worker keys it on
`CF-Connecting-IP`.)

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

The canonical Ola Ink service origin is `https://app.olaink.com` (moving to
Cloudflare; see [Cloudflare deployment](#cloudflare-deployment)). Terminate TLS
for that hostname in front of this HTTP process and run the process with
`OLAINK_PORT` (and, where appropriate, `OLAINK_HOST`). The companion defaults
to this origin. The production AuthGravity endpoint is
`https://authgravity.app.olaink.com` (the verifier calls `/v1/whoami`). Serve
laptop login and companion setup at `https://app.olaink.com/`; AuthGravity must
be configured with an RP ID of `app.olaink.com` or `olaink.com`, rather than
`localhost`.

## Cloudflare deployment

The canonical deployment is moving from the self-managed binary to a
Cloudflare Worker (`src/worker.ts`) with D1 for relational state and R2 for
encrypted note payloads; see
[`plans/migrate-to-cloudflare.md`](../../plans/migrate-to-cloudflare.md) for
phases and status. Until the Phase 4 cutover, `app.olaink.com` still points at
the binary above. Run the `wrangler` commands below from `packages/server/`.

### One-time setup

1. **Resources.** `npx wrangler login`, then create the databases and buckets
   named in `wrangler.jsonc` (single-region D1; never enable read replication
   or multi-region routing — the username ledger depends on it):

   ```sh
   npx wrangler d1 create olaink
   npx wrangler d1 create olaink-staging
   npx wrangler r2 bucket create olaink-notes
   npx wrangler r2 bucket create olaink-notes-staging
   ```

   Replace the two all-zero `database_id` placeholders in `wrangler.jsonc`
   (top level = production, `env.staging`) and commit them; the IDs are not
   secrets.
2. **First deploys** (creates both Workers; production is only reachable on
   its `workers.dev` URL until DNS is switched):
   `scripts/deploy-worker.sh staging`, then `scripts/deploy-worker.sh
   production` from the repository root. Note the two URLs
   (`https://olaink-staging.<subdomain>.workers.dev`,
   `https://olaink.<subdomain>.workers.dev`).
3. **CI credentials.** Create an account-scoped API token for this one
   account from the dashboard's "Edit Cloudflare Workers" template plus
   **Account › D1 › Edit** (migrations run with `--remote`). Then:

   ```sh
   gh secret set CLOUDFLARE_API_TOKEN
   gh secret set CLOUDFLARE_ACCOUNT_ID --body '<account id>'
   gh variable set STAGING_URL --body 'https://olaink-staging.<subdomain>.workers.dev'
   gh variable set PRODUCTION_URL --body 'https://olaink.<subdomain>.workers.dev'
   ```

   In GitHub **Settings › Environments**, create `staging` and `production`;
   give `production` a required reviewer and restrict it to the `main`
   branch. Last, arm the workflow: `gh variable set CLOUDFLARE_DEPLOY --body
   enabled`. After the cutover, set `PRODUCTION_URL` to
   `https://app.olaink.com`.

### Deploying

`.github/workflows/deploy.yml` runs on every push to `main` that touches the
server: repo gates (both vitest projects, Bun suite, typecheck, generated
files) → **staging** → waits for approval → **production**, always the same
commit. Each deploy runs `scripts/deploy-worker.sh`: `wrangler d1 migrations
apply --remote` (wrangler captures a D1 backup first), `wrangler deploy` with
the commit baked in, then a smoke check that `/healthz` answers and `/commit`
reports that commit.

The same script deploys by hand (it refuses a dirty working tree):
`scripts/deploy-worker.sh staging|production`, with `SMOKE_URL` set to run
the smoke check.

A bad release is reverted with `npx wrangler rollback` (add
`--env staging` for staging). Rollback restores code only, never the
database, so every migration must stay compatible with the previous release
(add columns and tables; drop only in a later release).

### Backups and restore

- **D1 point-in-time recovery.** D1 Time Travel keeps a restorable history
  for the plan's retention window (check Cloudflare's current limits):
  `npx wrangler d1 time-travel info olaink --timestamp <RFC 3339>` and
  `npx wrangler d1 time-travel restore olaink --timestamp <RFC 3339>`.
- **Off-Cloudflare exports (the durable record).** Weekly, and before any
  risky change:

  ```sh
  npx wrangler d1 export olaink --remote --output "olaink-$(date +%F).sql"
  ```

  Keep the exports indefinitely, encrypted, outside Cloudflare and never in
  this repository or in CI artifacts: they contain the account mapping and
  the username ledger. `account_usernames` (active names and retired
  tombstones) is what the no-reuse promise rests on; see
  [`docs/account-policy.md`](../../docs/account-policy.md). Restore into an
  empty database with `npx wrangler d1 execute <database> --remote --file
  <export.sql>`.
- **R2 payloads are not backed up.** They are ciphertext in flight: written
  at send, deleted when the last recipient device acknowledges. Losing them
  loses only undelivered notes, whose `.note` files remain on the sender's
  device to resend. Wrangler offers no R2 object versioning (only lifecycle
  and bucket-lock rules, and a lock would block the post-acknowledgement
  delete).

### Re-onboarding at cutover (two users, no data migration)

Cutover starts from empty D1/R2. AuthGravity accounts and passkeys are
unaffected; everything Ola Ink stored is recreated by the two users.

1. **Rehearse on staging.** Smoke-test the staging URL: `/healthz`,
   `/commit`, then the API with an AuthGravity bearer session ID
   (`Authorization: Bearer <session>`): `GET /v1/account`, claim the
   username, enroll a device, and send/poll/ack a note.
   Browser sign-in works only on an origin that AuthGravity's passkey RP ID
   (`app.olaink.com`) and session cookie cover, so a browser rehearsal
   needs a staging hostname under `app.olaink.com` (for example
   `staging.app.olaink.com`, Phase 0); it cannot work on `workers.dev`.
   For a Nomad pairing and delivery test against staging, build the
   side-by-side experimental plugin (plugin ID `olainknativeexp1`, so the
   installed production plugin and its pairing are untouched), pinned to
   staging's current leaf certificate:

   ```sh
   host=olaink-staging.<subdomain>.workers.dev
   pin=$(openssl s_client -connect "$host:443" -servername "$host" </dev/null 2>/dev/null \
     | openssl x509 -outform DER | sha256sum | cut -d' ' -f1)
   OLAINK_RELAY_BASE="https://$host" OLAINK_RELAY_CERT_SHA256="$pin" \
     experiments/native-client-plugin/buildPlugin.sh
   ```

   (Cloudflare rotates that certificate; rebuild if the pin stops matching.
   This path has not been exercised against staging yet.)
2. **Drain the old service.** Both users send, poll, and acknowledge until
   both inboxes on the current server are empty, so nothing is in flight
   across the switch; then stop accepting writes on the old binary.
3. **Switch DNS** for `app.olaink.com` to the production Worker (Phase 4).
4. **Each user, on `https://app.olaink.com/`:**
   1. *Continue with passkey* with the existing passkey.
   2. *Claim username*: the same username as before. It is free because the
      ledger starts empty; claim it promptly.
   3. *Create browser inbox key* (the old browser key is not registered on
      the new service).
   4. *Add Supernote companion*, then enter the eight-digit code in the Ola
      Ink plugin on the Nomad to pair it again.
   5. Resend any note that was not delivered before the drain.
5. **Verify:** `/commit` shows the deployed commit, and the two users
   exchange a note in both directions.

Rollback is switching DNS back to the old binary, kept running read-only for
14 days; its state is stale by design, so returning to it means running step
4 against it again.

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
and submit an immutable username. Retention expiry, audit events, and device
revocation remain required before production rollout.

## Browser inbox data and loss

The root page serves a self-hosted pinned Supernote viewer and browser inbox.
It persists only original encrypted records plus local read/received state in
IndexedDB. Decrypted filenames, sender labels, and `.note` bytes are held in
memory for the list/viewer and are not written to localStorage, URLs, or relay
storage. Clearing site data destroys the non-extractable private key: a newly
enrolled browser can receive future notes but cannot decrypt deliveries sent
only to the lost device.

## Pinned viewer assets

`public/supernote-viewer.js` is a generated asset, not source in this repo:

| asset | source | SHA-256 |
| --- | --- | --- |
| `public/supernote-viewer.js` | `philips/supernote-obsidian-plugin` commit `e60d7c5f16bacf9a50619c9ea2dd21bb47d33113` (PR #252), with the animation paint cap patched from 30 to 10 FPS | `2396f06078886881373fe7e087571d76c225860a2c90286016b033e0a50fd25f` |

Rebuild the pinned asset from a recursively cloned upstream checkout:

```sh
packages/server/scripts/update-pinned-viewer.sh /path/to/supernote-obsidian-plugin
```

The script verifies the upstream commit, applies the 10 FPS paint-cap patch,
checks the bundle against `VIEWER_SHA256`, and regenerates the server's
embedded copies (`src/viewerAsset.ts` and the on-board page). An upstream
update must review the commit, paint-cap patch, checksum, and this table
together.
