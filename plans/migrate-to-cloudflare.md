# Migrate the Ola Ink service to Cloudflare

## Handoff checkpoint — state as of 2026-07-09 (new harness: start here)

**Tree:** clean at `fa63b18`. **Gates green:** `npm run typecheck` (tsc) and
`npm test` (vitest: 28/28 across 11 files, incl. the Bun-environment SQLite
store suite). Bun on this machine is 1.4.0 (upgraded from 1.3.14 during the
WebCrypto port); Node v22.23.2.

**Phase 1 — done and committed:**
- `packages/server/wrangler.jsonc` — `main`, `compatibility_date`,
  `nodejs_compat`, `DB` (D1) + `NOTES` (R2) bindings, `vars.
  AUTHGRAVITY_WHOAMI_URL`, and the `OLAINK_BUILD_COMMIT` define
  (`scripts/build-server.mjs` already injects that expression, so
  `buildInfo.ts` works unchanged). Dev-only, no secrets committed; local
  `*.dev.vars` holds the binding IDs.
- `packages/server/migrations/0001_init.sql` — D1 schema (no
  `prototype_server_state`).
- `src/d1Store.ts` — async `D1Store` on the D1 API (`db.batch()`
  transactions), same method surface as `PrototypeSqliteStore`.
- `src/notePayloads.ts` — `NotePayloadStore` interface, `MemoryNotePayloadStore`,
  `R2NotePayloads` adapter (adapter written; **not yet wired** — see below).
- `src/d1RateLimiter.ts` — atomic D1 counter (written; **not yet wired**).
- WebCrypto rewrite of `src/prototypeNoteCrypto.ts` (marked [x] in Phase 1)
  + `src/bytes.ts` canonical base64url/base64 helpers with regression tests.

**Phase 1 — remaining, in order (this is the next work):**
1. **Async port of the services + wire in the new infra.** Everything below is
   written and unit-tested but **not yet wired to anything**:
   `D1Store`, `D1PairingClaimLimiter` (`src/d1RateLimiter.ts`),
   `NotePayloadStore`/`R2NotePayloads` (`src/notePayloads.ts`). Current live
   path is still sync: `httpApi.ts` constructs `PrototypeSqliteStore` +
   `PrototypeNoteRelay({ store })` (record JSON lives in the SQLite
   `prototype_notes` column), and the in-memory pairing-claim limiter is
   `OlainkServer.allowPairingClaim` inside `httpApi.ts`. To port:
   - `PrototypeNoteRelay` (`src/prototypeNoteRelay.ts`) → async on
     `D1Store` + `NotePayloadStore`: `send` does `payloads.put(recordId, json)`
     then `store.createNote` (metadata only) in one `db.batch()` (compensating
     R2 delete on failure, decision 2); `poll` does `store.listDeliveries` +
     `payloads.get` per row; `acknowledge` uses `D1Store.acknowledge`, which
     already returns `gcRecordIds` for last-delivery GC → `payloads.delete`
     (best-effort, log on failure).
   - `AuthGravityPairingService` (`src/prototypePairing.ts`) → async on
     `D1Store` (it drives the relay + store synchronously today).
   - `OlainkServer.allowPairingClaim` / `pairingClaimAttempts` →
     `D1PairingClaimLimiter` (keyed on the connecting IP, same 10-per-60s).
   - The relay's synchronous key validation uses pure-`assertPublicKeySync`
     (structural SPKI check, `prototypeNoteCrypto.ts`); the async path gets
     full WebCrypto `importKey` validation (remember: ECDH public keys import
     with `usages: []`).
2. **Fetch-handler core** — `src/handler.ts` + `src/worker.ts` replacing the
   `node:http` dispatch in `src/httpApi.ts` / `src/main.ts`. Keep the
   "Behavioral contract to preserve" list byte-for-byte (six-endpoint CORS
   matrix for `appassets.androidplatform.net`, nonce CSP on `/`,
   `x-olaink-device-session` bearer, 400/404/409/413/429 semantics, 10 MiB
   body cap). `httpApi.test.ts` exists and is green — port or retire it with
   the new handler.
3. **Local shims + standalone entry** — D1-API shim over `bun:sqlite`
   (surface: `prepare/bind/run/first/all/values/batch`; add a `node:sqlite`
   fallback for CI test envs), R2 shim over a local directory, `request.cf`
   synthesis, and a migration runner that applies `migrations/*.sql` in
   order. `src/standalone/main.ts` wraps the same handler in `Bun.serve`
   (decision 0). Keep `main.ts`/`httpApi.ts` alive until the swap, then
   delete them plus `prototypeSqliteStore.ts` (its server-state methods die
   with the `prototype_server_state` table the D1 schema already drops) and
   port their last test users (`prototypeSqliteStore.test.ts`,
   `httpApi.test.ts`) to the shims first.
4. **Build/test retarget** — `scripts/build-server.mjs` currently compiles
   `packages/server/src/main.ts` to the Bun binary (embed step
   `scripts/embed-onboard-page.mjs` runs first); retarget it to the
   standalone entry. Update server `package.json` scripts (`start`,
   `test:sqlite`) with it.
5. **Phase 2** — `npm test` becomes two runs: `@cloudflare/vitest-pool-workers`
   (Miniflare D1+R2) and node/shim env (standalone path), both green without
   a Cloudflare account; add the Phase 2 payload-specific and
   shim-conformance tests.

**Invariants (do not break):**
- The `.note` wire format is **frozen** (field names, AAD strings, HKDF
  salt/info, canonical unpadded base64url). `src/webCryptoInterop.test.ts`
  decrypts Node-encrypted records with an independent browser-style
  WebCrypto code path — it is the drift detector. The PWA's
  `src/notes/*.ts` crypto is untouched and is the reference.
- No data migration: two live users re-onboard at cutover (Phase 3 runbook);
  cutover starts from empty D1/R2.
- No Durable Objects / push delivery in this plan
  (`plans/push-delivery-durable-objects.md` is the parked follow-up).
- No secrets committed; wrangler env config is dev-only.
- Repo conventions in `AGENTS.md` (stable plugin ID; never commit `build/` or
  `.gradle/`; Supernote docs canonical; LLM features via TPX).

**Verification loop:** after every change, `npm run typecheck && npm test`
from the repo root must stay green. Device E2E (when ready) per AGENTS.md:
`adb connect 100.103.149.40:5555`, `scripts/snplg-deploy.sh packages/plugin`.

## Problem

The canonical service origin `https://app.olaink.com` is a single Bun-compiled
binary running on a self-managed Linux host (`/opt/olaink/olaink-server`,
SQLite on a local volume, TLS terminated in front). Operating it means patching
the host, rotating TLS, hand-backing up SQLite, and running one instance whose
in-memory pairing-claim rate limit is not proxy-aware or durable — the README
already lists "durable proxy-aware rate limits" as required before production
rollout.

This plan replaces that deployment with Cloudflare Workers, while keeping the
exact same public contract: same hostname, same endpoints, same auth flow,
same client code, same E2E-encrypted wire format. Self-hosting stays a
first-class, single-binary option running the identical code (decision 0).

## Goals

- `app.olaink.com` continues to serve the PWA inbox and the `/v1/*` API from a
  Cloudflare Worker. Clients (browser inbox, Nomad WebView, Android APK) see
  no URL, origin, or protocol change.
- All durable state moves to managed storage: D1 (SQLite) for relational state,
  R2 for opaque encrypted record payloads.
- The pairing-claim rate limit becomes a durable, proxy-aware D1 counter,
  replacing the per-instance in-memory map.
- CI builds, tests, and deploys the Worker (wrangler) from GitHub Actions.
- **No data migration:** the service has exactly two live users, so cutover
  starts from empty D1/R2. Both users re-authenticate (AuthGravity sessions
  are unaffected — they live in the AuthGravity pool), re-enroll/re-pair
  devices, and resend any notes; the `.note` bytes live on the devices, so no
  content is lost. Low-risk DNS cutover plus easy rollback.
- Self-hosting/forking stays easy: one bun-compiled binary runs the same
  Worker module against local SQLite + local disk, with no Cloudflare account
  and no runtime installed on the host (decision 0).
- The marketing site stays on GitHub Pages (Q5); its DNS is only touched if
  the NS move turns out to be needed (Phase 0b).

## Non-goals

- No client changes: the PWA, the pinned viewer, the Android companion, and the
  Supernote plugin are untouched. The plugin stays fully device-local.
- No protocol changes: `EncryptedNoteRecordV1`, device directories, pairing
  codes, and the AuthGravity session-forwarding flow are unchanged. Polling
  stays polling (no push/WebSocket upgrade in this migration).
- The AuthGravity pool at `authgravity.app.olaink.com` is a separate service we
  only call; it does not move in this plan (already hosted on Cloudflare by a
  third party).
- No multi-region D1, no Durable Objects, no server-side decryption — the relay
  remains opaque to ciphertext by construction.
- The old `node:http` dispatch shell is retired — it is replaced by the single
  fetch handler (decision 0/1).

## Target architecture

| Today (VPS)                                     | After (Cloudflare)                                                        |
|-------------------------------------------------|---------------------------------------------------------------------------|
| Bun-compiled `olaink-server` binary             | Worker (`wrangler deploy`); same module compiled to a self-host binary    |
| SQLite (WAL) on `/var/lib/olaink/`              | D1 database (migrations in repo)                                          |
| Note record JSON (up to 8 MiB) in `prototype_notes` | R2 object per record ID (immutable)                                  |
| In-memory pairing-claim rate limit              | Atomic D1 rate-counter table                                              |
| Embedded onboard page / viewer / logo in binary | Same generated modules bundled into the Worker                            |
| `bun --define` commit baking (`/commit`)        | `process.env.OLAINK_BUILD_COMMIT` define (wrangler in CI, bun in the binary) |
| VPS reverse proxy + cert                        | Cloudflare TLS on `app.olaink.com` (zone route, or CNAME to workers.dev if Phase 0a confirms) |
| GitHub Pages marketing site                     | Unchanged (its DNS is touched only if Phase 0b is chosen)                 |
| `sqlite3` backup discipline                     | Scheduled `wrangler d1 export` + R2 export/versioning                     |

One Worker module, one D1 schema, one R2 payload path, one rate limiter.
Two thin entry points: `wrangler deploy` (canonical) and the bun-compiled
standalone binary (self-host).

## Key design decisions

0. **One Worker codebase, two thin entry points (wrangler + bun binary).**
   The goal — make it easy for folks to self-host or fork the project, with a
   tested path — is met by packaging the *Worker module*, not wrangler
   (wrangler is only the deploy CLI and the local dev loop):
   - Canonical deployment: `wrangler deploy` to D1 + R2.
   - Self-hosting: `standalone/main.ts` imports the same Worker module and
     runs it with `Bun.serve` under a hand-built local `env`:
     - `DB`: a small D1-API shim over `bun:sqlite` (only the surface the store
       uses: `prepare/bind/run/first/all/values/batch`). D1 *is* SQLite, so
       local semantics match production engine-for-engine; `bun:sqlite` is
       built into the bun runtime, so `bun build --compile` produces the same
       single self-contained executable property the current binary has.
     - `NOTES`: R2 shim over a local directory (`put/get/delete/head`).
     - `request.cf.connectingIP`: synthesized from the socket IP;
       `ctx.waitUntil`: no-op. The handler contains no
       `if (self-host)` branches.
   - Migrations: the same `migrations/*.sql` files wrangler applies on
     Cloudflare, run by a small runner inside the binary on startup.
   - `wrangler dev` (Miniflare) remains the zero-config local dev loop.
   - Do **not** embed Miniflare in the binary (native dependency tree fights
     `--compile`); the shims are the right size.
   - Both entry points run the identical handler and are covered by the same
     contract test suite (Phase 2).
   - The old `PrototypeSqliteStore` (direct `bun:sqlite`/`node:sqlite`) is
     removed; its schema survives as the D1 migrations.

1. **Single fetch handler.** `node:http` does not exist on Workers. The
   `OlainkServer` dispatch logic becomes one fetch-style core
   (`request in → response out`), exposed as:
   - the Worker entry: `export default { fetch(request, env, ctx) }`;
   - the standalone entry: `Bun.serve({ fetch: (req) =>
     worker.fetch(withCf(req), localEnv, localCtx) })`.
   All handler and service methods become `async` (D1 is async). Enable the
   `nodejs_compat` compatibility flag for the first cut so `Buffer`/`node:crypto`
   keep working; a follow-up cleanup task replaces `Buffer` with
   `TextEncoder`/`Uint8Array` helpers and `node:crypto` with WebCrypto
   (`crypto.getRandomValues`, `crypto.subtle.digest('SHA-256')`). (Bun already
   provides both APIs, so the standalone path is unaffected either way.)

2. **Note payloads go to R2, not D1.** Records are up to 8 MiB of JSON; D1
   per-value limits are well below that (verify the current documented limit
   in Phase 1 and record it in code comments either way). R2 is the natural
   home for large immutable blobs: the record is written exactly once at
   `send` and read on `poll`. D1 keeps only the `prototype_notes` metadata
   (id, created_at) and the `prototype_note_deliveries` rows.
   - `send`: validate → `PUT notes/{recordId}` (R2) → insert metadata +
     delivery rows (one `db.batch()` transaction).
   - `poll`: delivery rows for the device (D1) → `get` each R2 object.
   - `acknowledge`: delete delivery rows in a batch; when a record's last
     delivery row is removed, `delete` its R2 object (best-effort; log on
     failure). No R2 lifecycle expiry until a client can tolerate a missing
     object, because un-acked devices must be able to re-fetch.
   - A failed send leaves no orphan payload or delivery rows (compensating
     write); record-ID single-use is kept by the unique metadata row.

3. **Single-region D1.** The permanent-username promise rests on
   `account_usernames` uniqueness. Keep D1 in one region (strongly consistent,
   synchronous) and do **not** enable multi-region routing. If multi-region is
   ever needed, the uniqueness race must be redesigned first.

4. **Hostname is load-bearing.** The AuthGravity RP ID is `app.olaink.com`
   (or `olaink.com`) and the Android companion hard-codes
   `https://app.olaink.com` and the `appassets.androidplatform.net` origin.
   Keep the exact hostname; cutover is a DNS change, never a client release.

5. **Durable rate limiting on the free plan.** `POST /v1/pairings/claim` gets
   an atomic D1 counter: `pairing_claim_buckets(client_key, window_start,
   count)` upserted with `ON CONFLICT DO UPDATE SET count = count + 1` and
   read back in one `db.batch()` transaction (same 10-per-60s limits as
   today), keyed on `request.cf.connectingIP`. This satisfies the README's
   "durable proxy-aware rate limit" requirement without the paid Rate
   Limiting binding, and removes the last per-instance in-memory state, making
   the Worker safely multi-instance. The same table works in the self-host
   binary via the shim. If we ever move to Workers Paid, the call site swaps
   to the built-in binding unchanged.

6. **Static assets stay embedded.** The generated `onboardPage.ts`
   (per-request CSP nonce), `viewerAsset.ts`, and `brandAsset.ts` keep being
   bundled into the Worker exactly as they are today — zero behavior change,
   `check:generated` keeps working unmodified. (Optional later: move the
   viewer/logo to a Workers static-assets binding; not required.)

7. **AuthGravity verification is unchanged.** The handler server-side
   `fetch`es `https://authgravity.app.olaink.com/v1/whoami` with the forwarded
   `Cookie`/`Authorization` header, same as today.

8. **CORS stays exact.** Only the six companion endpoints get CORS headers,
   only for origin `https://appassets.androidplatform.net`, with
   `Vary: Origin` and the same allow-listed headers/methods.

## Behavioral contract to preserve (regression checklist)

- Endpoints and semantics: `GET /v1/account`, `POST /v1/account/username`,
  `GET /v1/users/:username` (unknown and retired names are indistinguishable),
  `POST /v1/devices`, `POST /v1/pairings`, `POST /v1/pairings/claim`,
  `POST /v1/companion/{directory,notes,poll,ack,logout}`, `POST /v1/notes`,
  `POST /v1/poll`, `POST /v1/ack`, `GET /`, `GET /healthz`, `GET /commit`,
  `GET /olaink-logo.svg`, `GET /supernote-viewer.js`.
- Status codes: 200/201/202/400/401/404/409/413/429 exactly as today.
- 10 MiB body cap, 8 MiB record cap; oversized → 413 `record_too_large`.
- JSON body parse failure → 400 `bad_request`.
- CSP header on `/` with per-request nonce; `Cache-Control` on viewer/logo.
- `x-olaink-device-session` bearer capability, SHA-256-hashed at rest.
- Account-device boundary: no cross-account registration/poll/ack/send.

## Phases

### Phase 0 — Account, resources, and the hostname mechanism

No production DNS changes in this phase — `app.olaink.com` keeps pointing at
the VPS until the Phase 4 cutover, because live users must not hit an empty
Worker during Phases 1–3.

- [ ] Cloudflare account (free plan, Q3: manual backups are acceptable).
      `wrangler login`; create D1 database `olaink` (single region), R2 bucket
      `olaink-notes`, Workers script `olaink`. No Rate Limiting namespace —
      the limiter is a D1 table (decision 5). Record the D1/R2/worker IDs in
      `packages/server/wrangler.jsonc` bindings (committed); the API token
      stays a CI secret.
- [ ] **0a — test the no-NS-move path first (preferred).** Deploy the skeleton
      Worker, note its `olaink.<sub>.workers.dev` URL, and at the *current*
      DNS provider add a **scratch** subdomain (e.g. `cfcheck.olaink.com`
      CNAME → that URL). Verify over real HTTPS: cert valid for
      `cfcheck.olaink.com`, `Host` reaches the handler, `request.cf`
      populated, `/healthz` + `/commit` OK. Delete the scratch record.
      - If the cert is valid: **no NS move, ever.** Phase 4 cutover is a
        one-line CNAME edit of `app.olaink.com` at the current provider; the
        site and the third-party `authgravity` record are never touched.
      - If not (CF won't issue a cert for a zone it doesn't serve): proceed
        to 0b. (Stopgap alternative if 0b is deferred: keep the VPS as a
        TLS-terminating reverse proxy in front of the Worker — it works, but
        the VPS stays in the hot path.)
- [ ] **0b — only if 0a's TLS check fails:** add `olaink.com` as a CF zone.
      Before touching nameservers, snapshot the full current record set (site
      A/CNAME for GitHub Pages, `app.olaink.com`,
      `authgravity.app.olaink.com` — a third party's CF target — plus any
      MX/TXT). Move the registrar NS to Cloudflare and recreate the records:
      site → GitHub Pages IPs (proxied), `authgravity` → the captured target,
      `app` → the Worker route (flipped at the Phase 4 cutover, not before).
- [ ] Staging hostname: `staging.app.olaink.com` CNAME/route to the staging
      Worker if the zone is on CF; otherwise staging smoke tests use the raw
      `olaink-staging.<sub>.workers.dev` URL (the staging-pointing debug
      companion variant works either way).

**Acceptance:** `wrangler whoami`; `wrangler dev` with empty local D1/R2
boots and serves `/healthz`; the standalone binary starts against an empty
local data dir and serves `/healthz`; 0a vs 0b decided in writing (cert check
result recorded in this plan).

### Phase 1 — Worker port of the server

- [x] `packages/server/wrangler.jsonc`: `main`, `compatibility_date`,
      `compatibility_flags: ["nodejs_compat"]`, bindings `DB` (D1), `NOTES`
      (R2), `vars` (`AUTHGRAVITY_WHOAMI_URL`), `define` for
      `process.env.OLAINK_BUILD_COMMIT` — the expression
      `scripts/build-server.mjs` already injects, so `buildInfo.ts` works
      unchanged in both builds.
- [ ] Single fetch-style handler core (decision 1) replacing the `node:http`
      dispatch; keep routing/headers/status codes byte-for-byte per the
      contract checklist. Worker entry = `export default { fetch }`;
      standalone entry = `standalone/main.ts` with `Bun.serve` (decision 0).
- [x] `D1Store` (replaces `PrototypeSqliteStore`): same method surface, all
      `async`, `db.batch()` transactions; schema as `migrations/0001_init.sql`
      (drop `prototype_server_state` — its only purpose was a one-time legacy
      key cleanup that is obsolete with a fresh database).
- [x] WebCrypto rewrite of `prototypeNoteCrypto.ts` (async; wire format
      byte-identical — `webCryptoInterop.test.ts` stays the drift detector).
      Runtime gotcha recorded: **ECDH public keys must be imported with an
      empty `usages` list** (`importKey('spki', …, {name:'ECDH',…}, false, [])`)
      — the PWA already does this; Node/Bun reject non-empty usages for public
      keys. base64url must be canonical unpadded (`-`/`_` = 62/63); helpers
      live in `src/bytes.ts` with a `Buffer`-cross-checked regression test.
- [ ] `R2NotePayloads` adapter: `put(recordId, json)`, `get(recordId)`,
      `delete(recordId)`; wire into `PrototypeNoteRelay.send/poll` and the
      ack GC path (decision 2).
- [ ] `D1RateLimiter` (decision 5) replaces `allowPairingClaim` /
      `pairingClaimAttempts`.
- [ ] Local env shims for the standalone entry (decision 0): D1-API shim over
      `bun:sqlite` (with a `node:sqlite` fallback for the CI test env), R2
      shim over a local directory, `request.cf` synthesis, migration runner.
- [ ] `scripts/build-server.mjs` retargeted: still `bun build --compile`, now
      bundling the Worker module + standalone entry (embed step for the
      generated page/viewer/brand assets runs the same as today).

**Acceptance:** `wrangler dev` serves the full API locally; the standalone
binary does the same against a local data dir; existing tests pass (Phase 2).

### Phase 2 — Test port

- [ ] Two test runs behind `npm test`:
      - `@cloudflare/vitest-pool-workers` run: Workers runtime with real
        (Miniflare) D1 + R2 bindings — the production-shaped path;
      - node/bun-environment run: the standalone env (D1 shim over
        `node:sqlite`/`bun:sqlite`, R2 shim on a temp dir) — the self-host
        path stays tested (decision 0).
- [ ] The behavioral contract suite (account → username → device → send →
      poll → ack, plus the CORS matrix: six companion endpoints, one origin,
      headers/methods, `Vary: Origin`) is written against the fetch core and
      runs in **both** environments, with the injected fake
      `AuthGravityVerifier` as today.
- [ ] Keep `pretest`/`check:generated` unchanged (generated modules bundle
      into the Worker and the binary the same way they do today).
- [ ] Add payload-specific tests: payload written once, poll reads it, ack of
      last delivery deletes it, re-poll of an un-acked record still works;
      failed `send` leaves no orphan state.
- [ ] Add shim-conformance tests: D1 shim matches the D1 API subset the store
      uses (batch atomicity, `first()` null semantics, row shapes).

**Acceptance:** `npm test` green on CI without a Cloudflare account.

### Phase 3 — Staging deploy and re-onboarding

No data migration (two live users, fresh start — see Goals).

- [ ] Deploy the Worker to a **staging** target first: CNAME
      `staging.app.olaink.com` (or the raw workers.dev subdomain) against the
      staging D1/R2. Run a live smoke suite:
      `/healthz`, `/commit`, signed-in `GET /v1/account`, username re-claim,
      a real pairing claim from a Nomad, a real send/poll/ack of a note
      (proves the R2 round-trip).
- [ ] Re-onboarding runbook (documented in README) for the two users,
      executed once against staging: log in with the existing passkey
      (AuthGravity is untouched), claim the same username, enroll the device
      key, re-pair the companion, resend outstanding notes from the device.
- [ ] Pre-cutover drain: both users send/poll/ack until their inboxes are
      empty on the VPS (nothing in flight crosses the flip).
- [ ] Document the backup discipline (free plan, Q3): scheduled `wrangler d1
      export` (weekly cron job + on-demand before risky changes) and an R2
      bucket export, archived outside Cloudflare; enable R2 bucket versioning
      as a safety net for accidental deletes. The no-username-reuse promise
      now rides on these exports — same promise, new procedure (update
      `docs/account-policy.md`).

**Acceptance:** staging passes the smoke suite including a real Nomad E2E
pairing + delivery; both users are fully re-onboarded on staging.

### Phase 4 — Cutover

- [ ] Low-traffic window. Keep the VPS process running (it will go stale, not
      broken — writes there after cutover are the hazard, so put the VPS
      binary into read-only/refused mode first: drain, then stop accepting
      writes while DNS flips; window is short because traffic is light).
- [ ] Point `app.olaink.com` at the Worker: the one-line CNAME edit at the
      current DNS provider (0a) or the record in the CF zone (0b) — the
      mechanism was already proven on a scratch subdomain in Phase 0.
- [ ] Post-cutover verification: `/healthz`, `/commit` shows the deployed
      SHA, a full device-pairing E2E on the Nomad, browser login with an
      existing passkey (proves AuthGravity cookie forwarding), both users
      re-onboarded via the runbook and a note exchanged between them.
- [ ] Monitor Workers Metrics/Logs (enable Workers Logs for `olaink`) for 24–48 h.
- [ ] **Rollback:** flip DNS back to the VPS (kept warm, read-only, for 14
      days). Nothing is back-filled: the VPS state is stale by design, and a
      rollback just means re-running the re-onboarding runbook against it.

### Phase 5 — Site, CI, docs, decommission

- [ ] Marketing site stays on GitHub Pages (Q5): verify its records in the
      Cloudflare zone (A → GitHub Pages IPs, proxied; `olaink.com/install`
      still resolves) after the NS move; `deploy-site.yml` is unchanged.
- [ ] New `deploy.yml` workflow implementing the Deployment model section:
      `cloudflare/wrangler-action`, auto staging mirror from main, production
      gated by a GitHub environment approval, `OLAINK_BUILD_COMMIT=${GITHUB_SHA}`
      defined at deploy time, D1 migrations applied before each deploy.
- [ ] Add `staging` branch (mirror of main) + staging hostname per the
      Deployment model section (CNAME to the staging Worker if the zone is on
      CF, otherwise the raw workers.dev staging URL).
- [ ] Keep the self-host binary in CI (decision 0): retargeted
      `scripts/build-server.mjs` + `build:server[:arm64]` still publish the
      x64/arm64 artifacts from `build-android-apk.yml`/a workflow, now
      labeled as the self-host binary (same Worker module, local SQLite/R2).
- [ ] Docs: `packages/server/README.md` (canonical deployment = Cloudflare
      Worker; self-hosting recipe = run the binary with `--database`/data
      dir, or fork to your own CF account; backup/restore via D1/R2 or the
      local data dir, `/commit`, rate limiting), `DEVELOPER.md` (local dev =
      `wrangler dev` or the standalone binary; migration scripts),
      `AGENTS.md` (deployment model), `docs/account-policy.md` (backup
      promise now covers the D1/R2 exports).
- [ ] After the 14-day rollback window: archive the final SQLite snapshot
      cold, stop the VPS process, keep the box (or let it expire per your
      infra policy).

## Deployment model (CI)

- **`wrangler deploy` from GitHub Actions** via the official
  `cloudflare/wrangler-action`. Repo secrets: `CLOUDFLARE_API_TOKEN` (an
  account-scoped token, not user-global: `Workers Scripts: Edit`,
  `D1: Edit` for `migrations apply --remote`) and
  `CLOUDFLARE_ACCOUNT_ID`. (The dashboard's first-party GitHub integration is
  the zero-YAML alternative — fine for default-branch + PR previews, but the
  wrangler action is what gives us the two-environment setup below.)
- **Two Workers, one config:** `packages/server/wrangler.jsonc` carries the
  production bindings at the top level and an `env.staging` block
  (`name: olaink-staging` + staging D1 database and R2 bucket IDs).
  `wrangler deploy` → production; `wrangler deploy --env staging` → staging.
- **Branch model:**
  - `staging` is a long-lived **mirror of main**: a workflow force-pushes
    `main` → `staging` on every main push, so staging never diverges.
  - Pushes to `staging` auto-deploy the staging Worker (tests +
    `wrangler d1 migrations apply olaink-staging --remote` first).
    `staging.app.olaink.com` CNAMEs to it.
  - Production deploys run **from `main`** but are gated by a GitHub
    **environment approval** (`environment: production` with required
    reviewers) — promotion is a deliberate click after the *same commit* has
    been live in staging. (Actions can't express cross-branch job
    dependencies, so the environment gate is the mechanism.)
  - Order inside each deploy job: `npm ci` → `npm test` → `check:generated`
    → `wrangler d1 migrations apply --remote` → `wrangler deploy`.
- **Staging is a fresh start:** staging D1/R2 are isolated and empty (there
  is no data migration to rehearse — see Phase 3). Caveats: staging is a
  different origin
  (passkey/cookie logins are fresh there), and the release Nomad companion is
  pinned to `app.olaink.com` — device E2E against staging needs a
  staging-pointing debug companion variant.
- **Optional later:** canary production rollouts via `wrangler versions
  upload` + `wrangler deployments create --percentage` (same Worker, traffic
  split) — only worth it if traffic grows.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| D1 per-value limit < record size | Payloads live in R2 by design (decision 2); verify and document the limit in Phase 1 |
| Username uniqueness race if D1 ever goes multi-region | Single-region D1, synchronous (decision 3) |
| Losing `account_usernames` tombstones breaks the no-reuse promise | Fresh start: the two users re-claim their current usernames via the staging runbook before cutover; thereafter scheduled D1 exports + off-Cloudflare archive carry the tombstones |
| Cutover splits an in-flight note (sent pre-flip, polled post-flip) | No migration: the pre-cutover drain empties both inboxes; anything unsent is on the device and is resent after cutover |
| Pairing code created pre-cutover, claimed post-flip (or vice versa) | Codes don't cross systems; the re-onboarding runbook covers re-pairing either side |
| Rate limiting without the paid binding | Atomic D1 counter is durable and proxy-aware (decision 5); the same call site swaps to the built-in binding if we ever move to Workers Paid |
| Local D1/R2 shims drift from real D1/R2 semantics | Shim is the same SQLite engine as D1; shim-conformance tests + one contract suite running in both environments (Phase 2) |
| `bun build --compile` + bundler friction in the binary | No native deps in the bundle (`bun:sqlite` is runtime-built-in; Miniflare is explicitly excluded from the binary, decision 0); the current binary already proves this pipeline |
| Workers free-plan 100k requests/day cap vs poll volume | Monitor usage metrics after cutover; upgrading to Workers Paid is a config change |
| NS move (0b only) breaks the marketing site or the third-party authgravity record | NS move only if the Phase 0a TLS check fails; full DNS snapshot before the change; verify site + whoami immediately after |
| CNAME-to-workers.dev path (0a) may not get a valid CF-issued cert for a zone CF doesn't serve | Decided by the scratch-subdomain test in Phase 0 before any production DNS change; fallbacks are 0b or the VPS as TLS-terminating proxy |
| Worker cold starts / auth round-trip latency | Stateless handler; one server-side whoami fetch (~50–150 ms) as today; poll interval is client-controlled |
| Cloudflare now hosts ciphertext + the name ledger (operator trust change) | Unchanged from any hosted relay: they can read routing metadata and opaque ciphertext, never plaintext (E2E preserved); state this explicitly in README |
| `appassets.androidplatform.net` CORS drift breaks Nomad pairing | Contract test in Phase 2; Nomad E2E in Phase 3/4 |

## Resolved questions

1. **Q1 — Zone:** `olaink.com` is **not** on Cloudflare today → Phase 0
   tests the no-NS-move path first (CNAME to workers.dev, checked on a
   scratch subdomain); the zone move + NS change happens only if TLS can't
   be served that way.
2. **Q2 — AuthGravity pool:** already hosted on Cloudflare by a third party;
   stays put — its DNS record is touched only if Phase 0b is chosen.
3. **Q3 — Plan tier:** free plan; manual/scheduled backups are acceptable →
   D1 atomic rate counter instead of the paid Rate Limiting binding
   (decision 5).
4. **Q4 — Self-hosting:** keep it first-class (decision 0): the bun-compiled
   standalone binary runs the same Worker module over local SQLite (D1 shim)
   and local disk (R2 shim) — no Cloudflare account required. For an extra
   option, a fork can also point wrangler at its own free CF account.
5. **Q5 — Marketing site:** stays on GitHub Pages.
6. **Q6 — Push delivery:** parked in its own plan, see
   [`plans/push-delivery-durable-objects.md`](push-delivery-durable-objects.md).

## Estimated effort

- Phase 0: ~half a day (account/zone work).
- Phase 1+2: the bulk — 3–5 days (fetch-handler + async D1 store port, R2
  adapter, local shims, both test environments).
- Phase 3: ~half a day (staging E2E on a real Nomad + re-onboarding runbook).
- Phase 4: an hour window + 24–48 h monitoring.
- Phase 5: ~half a day.
