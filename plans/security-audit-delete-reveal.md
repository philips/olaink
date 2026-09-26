# Security audit: endpoints that delete or reveal data

Audit scope, method, and findings for the relay endpoints that can (a)
disclose ciphertext/routing metadata to a party other than its owner, or
(b) delete/mutate delivery state (acknowledge, unregister a device, purge on
retention). The plugin's NPK/record-v1 crypto is out of scope here — it is
covered by `webCryptoInterop.test.ts` and `plans/issue 15` — this audit is
about the relay's authorization boundary (`packages/server/src/handler.ts`,
`prototypeNoteRelay.ts`, `prototypePairing.ts`, `d1Store.ts`).

## 1. Trust boundaries

- **AuthGravity session** (cookie or bearer, validated via `/v1/whoami`):
  authorizes `/v1/account*`, `/v1/devices`, `/v1/pairings`, `/v1/users/:name`,
  `/v1/notes`, `/v1/poll`, `/v1/ack`. Scoped to one opaque `userId`.
- **Device-session capability** (`X-OlaInk-Device-Session`, a 256-bit token,
  SHA-256-hashed at rest): authorizes exactly one `deviceId` for
  `/v1/companion/*`. Deliberately *not* an account credential — it cannot
  reach `/v1/account*`, `/v1/devices`, or `/v1/pairings`.
- **Pairing code** (8 digits, single-use, 10-minute TTL, rate-limited):
  exchanges for a device-session token exactly once.
- **Origin allowlist** (`appassets.androidplatform.net`) gates only the CORS
  *response headers* on `/v1/companion/*`; it is not an authorization check
  (dispatch never branches on it). The device-session token is the only real
  authorization boundary for those routes — confirmed by test (§4.9).

## 2. Data classified by endpoint

| Endpoint | Deletes | Reveals |
|---|---|---|
| `POST /v1/ack`, `POST /v1/companion/ack` | delivery rows (+ GC'd payload when last recipient acks) | acknowledged count only |
| `POST /v1/companion/logout` | device, its sessions, its pending deliveries (GC'd payloads) | — |
| `runRetentionSweep` (cron; not HTTP-reachable) | notes/deliveries/payloads past 14 days | — |
| `POST /v1/poll`, `POST /v1/companion/poll` | — | this device's queued ciphertext records |
| `GET /v1/users/:username`, `POST /v1/companion/directory` | — | recipient directory (userId, device IDs, public keys) |
| `GET /v1/account` | — | own userId/username |
| `POST /v1/notes`, `POST /v1/companion/notes` | — (write) | accepts/rejects only; never echoes ciphertext/filename |

## 3. Audit checklist (static)

- [x] Every delete/reveal handler resolves the acting principal from a
      verified session, never from a client-supplied ID alone.
- [x] `deviceId` ownership is re-checked server-side on every poll/ack/notes
      call (`ownerOfDevice`, `pairedDevice`), not cached from pairing time.
- [x] Cross-account/cross-device errors are uniform (`unknown_device`,
      `unknown_user`) regardless of "doesn't exist" vs. "exists but not
      yours" — enumeration resistance (§4.4, §4.7).
- [x] Record IDs, device IDs, user IDs are validated against a closed
      `[A-Za-z0-9_-]{1,128}` charset before touching SQL bind params or R2/FS
      keys — no injection or path traversal surface (`isIdentifier`,
      `DirectoryNotePayloads.path`).
- [x] Foreign-key cascades (`ON DELETE CASCADE`) match the manual GC logic;
      conformance is pinned by `d1Conformance.test.ts` and `PRAGMA
      foreign_keys = ON` is set explicitly for the SQLite shim.
- [x] Device-session tokens are opaque, 256-bit, hashed at rest, and
      single-slot per device (re-pairing revokes the old token).
- [x] Retention sweep is not reachable over HTTP; only `scheduled()` (Worker
      cron) and an explicit CLI flag (standalone) call it.
- [x] **Fixed:** `recordIds` on `/v1/ack` and `/v1/companion/ack` is now
      capped at `MAX_ACK_RECORD_IDS` (500) and rejected with 400
      `too_many_record_ids` above it. See finding A below.
- [ ] **Watch:** CORS response headers on `/v1/companion/*` are cosmetic
      (origin-gated headers only, not an authorization gate). This is
      intentional per the code comment, but it means any HTTP client — not
      just the Android WebView — can call companion routes with a valid
      device-session token. Confirmed as intended, not a bug, but worth a
      comment/test so it isn't "fixed" into a false sense of CORS security
      later (§4.9 pins the current behavior).

## 4. Findings

### A. Unbounded `recordIds` array on ack (DoS) — Medium — **Fixed**

`handleAck`/`handleCompanionAck` validated that `recordIds` was a string
array but never capped its length. `MAX_BODY_BYTES` (10 MiB) bounds total
request size, but a JSON array of 1-character identifiers costs ~4 bytes
each, so a single request could carry on the order of 2–3 million entries.
`D1Store.acknowledge` turned that directly into a `db.batch()` of one
`DELETE` per (deduplicated) ID. Even after `Set` dedup, an attacker only
needed sufficiently distinct short strings to keep the batch large.

*Impact:* CPU/latency amplification against D1 (and the SQLite shim) from a
single authenticated request; bounded by having a valid device/account
session, so not anonymous, but any paired device or logged-in account could
trigger it repeatedly.

*Fix:* `handler.ts` now defines `MAX_ACK_RECORD_IDS = 500` and both
`handleAck` and `handleCompanionAck` reject `recordIds.length >
MAX_ACK_RECORD_IDS` with `400 { error: 'too_many_record_ids' }`, checked
after the array-shape validation and before the device-ownership check (same
position as the existing `invalid_ack` check), so it never leaks device
ownership information. 500 comfortably covers any real poll batch (bounded
by `MAX_RECORD_BYTES` per note and normal client behavior of acking what it
just polled).

*Test:* `adversarial.test.ts` → "ack rejects an oversized recordIds array
instead of processing it (finding A, fixed)" and "companion ack rejects an
oversized recordIds array the same way as the account path" — assert 400
`too_many_record_ids` above the cap and normal 200 behavior at/under it, on
both `/v1/ack` and `/v1/companion/ack`.

### B. No new authorization bypass found

Every adversarial scenario below (cross-device ack, cross-account poll,
device-session token confusion within the *same* account, post-logout
replay across all four companion routes, stale-directory exclusion, sender
spoofing) was rejected correctly. No IDOR, no injection, no orphaned
plaintext leakage found in the current handler/relay/store code.

## 5. Adversarial test plan (implemented in `packages/server/src/adversarial.test.ts`)

1. Cross-device ack cannot delete another device's delivery; the victim
   still receives it on the next poll.
2. Ack has no upper bound on `recordIds` length (finding A, regression-locked).
3. A device-session token minted for device A is rejected when the request
   names a *different, real* device B on the same account ("confused
   deputy" — not just an unrelated account).
4. `unknown_device` is returned identically whether `deviceId` truly does
   not exist or exists but is owned by someone else (enumeration safety).
5. Concurrent duplicate `/v1/ack` HTTP calls for the same record acknowledge
   it exactly once in total, not once per request (race safety at the HTTP
   layer, not just the store layer already covered elsewhere).
6. After `/v1/companion/logout`, the revoked token is rejected on *all four*
   companion routes (poll, ack, directory, notes), not just poll.
7. A stale directory version/key-slot set — captured before the victim
   enrolls a second device — is rejected outright rather than silently
   delivering to only the old device list.
8. Sender-field spoofing (`fromUserId` set to a victim's userId while
   authenticated as the attacker) is rejected before any storage write; no
   orphan payload or delivery row is created.
9. Companion routes authorize purely on the device-session token: a request
   with a valid token but no `Origin` header (i.e., not a browser) still
   succeeds, and one with a forged Android origin but an invalid/absent
   token still fails — pins CORS-is-not-authorization as intended.
10. Injection-shaped identifiers (`' OR '1'='1`, `../../etc/passwd`,
    `__proto__`, embedded NUL) in `deviceId`, `username`, pairing `code`, and
    `recordIds` are inert: rejected as invalid input, never a 500, and never
    change query results for other principals.

Run: `npx vitest run --project node packages/server/src/adversarial.test.ts`
(and `--project workers` for the D1/R2-backed path — see `vitest.config.ts`).
