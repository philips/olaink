# Immutable usernames and account setup

## Goal

Give every Ola Ink account one public username that other people can use as the
recipient address. A username is **permanently assigned**: its owner cannot
rename it, and it is never assigned to another account, including after account
deactivation or deletion.

The AuthGravity subject remains the authentication identity. The username is an
Ola Ink profile/routing identifier, not an AuthGravity username, email, or
subject. The existing random `account_...` ID remains the opaque internal
recipient ID used in device directories and encrypted records.

## Non-negotiable rules

1. Claiming is authenticated by AuthGravity; the client never supplies an
   account ID or subject to claim a name for someone else.
2. The server is the only authority that decides availability and writes an
   assignment. Client-side availability checks are advisory only.
3. One account may have zero or one username. Once it has one, its username
   field is immutable.
4. A normalized username can appear in exactly one persistent assignment row.
   That row is never deleted or updated to a different account.
5. Closing an account changes its username row to `retired`; it does not free
   the name. Retired names produce the same unavailable result as active names.
6. No administrative rename/reclaim endpoint, SQL maintenance recipe, or
   `INSERT OR REPLACE` path is provided. Exceptional support work must create a
   new account and must not transfer the original name.

These rules deliberately favor a stable address over correcting typos. The UI
must make the finality clear before the user submits.

## Username contract

Use a deliberately small ASCII namespace to avoid Unicode normalization and
look-alike problems:

- Canonical value: lowercase ASCII, 3–24 characters.
- Allowed characters: `a-z`, `0-9`, and a single `-` between alphanumeric
  segments; no leading/trailing dash and no `--`.
- Examples: `mira`, `mira-notes`, `a5x-2026`.
- Reject spaces, punctuation other than `-`, and all Unicode characters.
  Canonicalize ASCII uppercase to lowercase at the server; the setup field may
  do the same while typing, but the server remains authoritative.
- Maintain a server-side reserved list for product names, endpoints, protocol
  words, and abuse-prone names (at least `admin`, `api`, `app`, `authgravity`,
  `echo`, `help`, `olaink`, `root`, `support`, and `www`). Reserved
  names are permanently unavailable too.

## Persistent model and migration

Keep AuthGravity subject mapping and public-name ownership separate:

```sql
-- Existing prototype_accounts stays the private subject -> opaque account map.
-- Add a durable, append-only ownership ledger.
CREATE TABLE account_usernames (
  canonical_username TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  assigned_at INTEGER NOT NULL,
  retired_at INTEGER
);
```

- The primary key makes name reuse impossible across restarts and concurrent
  requests. The unique `user_id` enforces one name per account.
- `status = 'retired'` preserves the claim forever. Do not add a foreign key
  with `ON DELETE CASCADE`; that would accidentally make a name reusable.
- Account data erasure needs a documented exception: retain this minimal
  tombstone solely to enforce the no-reuse promise. Before implementing account
  deletion, get a privacy/legal decision on whether to retain canonical text or
  a server-keyed digest plus necessary audit metadata.
- Migration creates the table before serving the endpoint. Existing
  AuthGravity-mapped/pairing accounts remain *unconfigured*; never invent a
  username from their opaque ID or an old anonymous peer name. They claim once
  on their next visit.
- Backups, restores, and production migrations must include this table. A
  restore missing it can violate the promise, so deployment health/backup
  documentation must call it out explicitly.

Implement the write as `BEGIN IMMEDIATE` (or a single equivalent SQLite
transaction): resolve the authenticated subject to its opaque account ID, read
any existing assignment for that account, validate/reserve the requested name,
insert exactly once, then commit. Translate unique-constraint races to the
same `username_unavailable` response; never retry with a different name.

## API design

Replace public use of raw `userId` with username lookup for normal clients.
Keep opaque IDs inside relay records only.

| Endpoint | Auth | Behavior |
| --- | --- | --- |
| `GET /v1/account` | AuthGravity | Returns the caller's opaque account state and username, if assigned. Creates/returns the durable subject mapping but does not create a device or name. |
| `POST /v1/account/username` | AuthGravity | Body `{ username }`. Atomically makes the caller's first and only assignment. Returns the canonical username and account state. |
| `GET /v1/users/:username` | Public or authenticated by final routing policy | Resolves an active canonical username to the recipient's opaque account ID and current public device directory. A retired or unknown name is not resolvable. |

`POST /v1/account/username` responses:

- `201 username_assigned`: first successful claim.
- `200 username_assigned`: idempotent retry by the same account for its exact
  canonical username (important after a lost response).
- `400 invalid_username` or `reserved_username`: invalid syntax/reserved word.
- `401 auth`: no valid AuthGravity identity.
- `409 username_unavailable`: held by any active or retired account.
- `409 username_already_assigned`: caller owns a different immutable name.

Do not implement `PUT`, `PATCH`, `DELETE`, an availability-reservation API, or
a username transfer API. If a `GET /v1/usernames/:username/availability` hint
is later added, rate-limit it and state in its response/UI that it is not a
reservation.

The authenticated pairing-start endpoint must require a username before it
registers the primary device or issues a pairing code. This produces the setup
order: authenticate → choose final username → enroll browser device → create
companion pairing code. Existing unconfigured accounts should receive
`409 username_required` and be sent back to the setup step.

## `https://app.olaink.com/` setup experience

The root page is the only browser entry point. It already performs AuthGravity
passkey registration/login and primary-device pairing; extend it with explicit
account state rather than exposing the AuthGravity endpoint as normal product
configuration.

1. On load, call AuthGravity `/v1/whoami`, then `GET /v1/account` through Ola
   Ink.
2. If unauthenticated, show **Create account** and **Log in**. Keep the
   production AuthGravity endpoint fixed to
   `https://authgravity.app.olaink.com` in production; test builds may expose
   an override.
3. If authenticated with no username, show a username form, syntax guidance,
   reserved-name validation, and a required confirmation: “This username is
   permanent. You cannot change it, and nobody else can use it later.” Disable
   device enrollment until the claim succeeds.
4. On `201`, display the canonical username as the account address. On `409`,
   retain the typed value and offer a new choice without implying a retry will
   reserve it. On network ambiguity, retry the exact same request; the
   idempotent server response resolves it safely.
5. If already assigned, display `@username` as read-only, include the creation
   time, and never render an edit/rename control.
6. Only then generate/load the browser IndexedDB device key, call pairing
   start, and show the one-time code for the companion. The existing companion
   claim flow remains code-based and never selects a username.

A future send UI takes `@username`, normalizes it with the same product parser,
resolves its directory, and encrypts to that snapshot. It must not present the
opaque `account_...` value as a user-facing identifier.

## Implementation slices

1. **Define the contract.** Add a server-owned username normalization module,
   reserved-name list, unit tests, API response types, and a short privacy/
   support policy documenting immutable assignment and permanent tombstones.
2. **Persist ownership.** Add `account_usernames` migration and transactional
   store methods such as `accountForSubject`, `usernameForUser`,
   `claimUsername`, and `resolveActiveUsername`. Test restarts, constraint
   races, rollback, and backup/restore behavior.
3. **Gate server APIs.** Add authenticated account/claim endpoints; change
   pairing start to require an active username; add username-to-directory
   resolution. Keep the current raw prototype device routes explicitly
   development-only until replaced by device-bound authorization.
4. **Build root setup UI.** Add account-state fetch, final username form,
   pending/error/retry states, read-only existing profile, and pairing gating.
   Regenerate `src/onboardPage.ts` from `public/onboard.html` as part of the
   server build.
5. **Adopt usernames in compose.** Use username lookup for recipient
   selection, retain the resolved opaque ID only inside the encrypted-record
   operation, and add two-browser/WebView integration coverage.
6. **Remove legacy overlap.** Retire anonymous `hello`/generated-name flows and
   any UI that treats a connection username as an account identity. Do this
   with the broader plaintext page-relay removal, not by silently migrating
   legacy names.

## Required tests and acceptance checks

- Invalid, reserved, mixed-case/Unicode, and boundary-length inputs are
  rejected consistently by UI and server.
- Two concurrent authenticated accounts claiming the same name yield exactly
  one `201`; the other receives `409 username_unavailable`.
- A restart and SQLite backup/restore retain both active assignments and
  retired tombstones.
- The same account can safely retry its exact claim after a dropped response,
  but cannot claim any different name afterward.
- A deleted/retired account's name cannot be claimed, resolved, or sent to;
  it is never reassigned.
- A second AuthGravity subject cannot obtain another account's username, and
  clients cannot provide or substitute a `userId` in account mutation calls.
- Pairing cannot start without a username; it still works for an authenticated,
  named account and binds both devices to the same opaque account ID.
- A sender can resolve `@username`, encrypt to the returned exact directory,
  and a relay capture contains no AuthGravity subject, username inside note
  plaintext metadata, or private key.
- Root setup clearly communicates permanence before assignment and exposes no
  rename action afterward.
