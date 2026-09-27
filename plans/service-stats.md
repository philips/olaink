# Public service stats (`GET /stats`)

Status: **implemented**, per the design below.

## Goal

A public, unauthenticated operational dashboard at `https://app.olaink.com/stats`
showing aggregate counts and storage size: how many users, how many messages
are in storage, how big the object store is, and the distribution of storage
across accounts.

## Why this is safe to publish without authentication

The relay's whole design already assumes an untrusted network sees routing
metadata (see `plans/issue 15` / the top-level architecture): it never learns
note content, filenames, or contact graphs beyond one recipient username per
send. `/stats` follows the same rule, one level up: it exposes **only
aggregate counts and byte totals**, never anything scoped to an identifiable
account:

- No usernames, user IDs, device IDs, or record IDs are ever rendered.
- The one per-account breakdown (storage by account) is reduced to
  min/median/mean/max across the whole active user base before rendering —
  the individual values never leave the server.
- Sizes are ciphertext byte counts; content is and remains opaque to the
  relay.

This mirrors what a lot of small services publish as a status/transparency
page and gives operators (and anyone curious) a way to sanity-check growth
and storage cost without needing a Cloudflare login.

## What's shown

**Accounts**
- Active users — accounts with a claimed, non-retired Ola Ink address
  (`account_usernames.status = 'active'`).
- All-time accounts — every AuthGravity-linked account ever created, with or
  without an address (`prototype_accounts`).
- Enrolled devices — primary/browser inbox devices (`prototype_devices`).
- Paired companions — currently-valid Supernote/Pi device sessions
  (`prototype_device_sessions`).

**Messages**
- Currently queued — notes sent but not yet fully delivered+acknowledged or
  purged by the 14-day retention sweep (`prototype_notes` row count).
- Sent all-time — a lifetime counter that keeps counting after a note is
  delivered or purged (see below; `prototype_notes` alone can't answer this
  because delivery/retention deletes the row).
- Accounts with queued mail, and the average queued message size.

**Object storage**
- Currently stored — sum of ciphertext object sizes for queued messages.
- Sent all-time — sum of ciphertext bytes ever enqueued.

**Storage by account**
- Min/median/mean/max of per-account queued storage, computed across *every*
  active-username account (accounts with nothing queued contribute 0). This
  answers "how skewed is storage usage" without naming who's at the top.

## Implementation

Two schema additions (`migrations/0002_service_stats.sql`), chosen
specifically so `/stats` needs no R2 `list()` call and no change to the
opaque-payload contract:

- `prototype_notes.size_bytes`: the ciphertext JSON byte length of the
  record, captured once in `PrototypeNoteRelay.send()` (it already computes
  `JSON.stringify(record)` to store the R2 payload) and passed to
  `D1Store.enqueue()`. This makes "current/pending storage" and the
  per-account distribution pure SQL over `prototype_notes`, joined through
  `prototype_note_deliveries` → `prototype_devices` to find each note's
  recipient account.
- `service_counters` (`key TEXT PRIMARY KEY, value INTEGER`): a tiny
  key/value table for two lifetime counters, `lifetime_messages_sent` and
  `lifetime_bytes_sent`, bumped only when `enqueue()`'s `INSERT ... ON
  CONFLICT DO NOTHING` actually creates the row — an idempotent resend of a
  still-pending record (the client retry case `send()` already tolerates)
  does not inflate them, but a note that is fully redelivered later under a
  fresh ID naturally does.

`D1Store.stats()` runs these queries and returns one `ServiceStats` object;
`statsMath.ts#summarizeDistribution` reduces the per-account byte array to
min/median/mean/max; `statsPage.ts` renders the final HTML. `handler.ts`
serves it at `GET /stats` with no session check, and with
`Cache-Control: public, max-age=60` -- unlike every other HTML response here
(the onboard/login page), the bytes are identical for every visitor, so a
short public/edge cache is safe and avoids re-running the queries above on
every hit.

## Non-goals

- Historical/time-series charts (this is a live snapshot, not a metrics
  pipeline; Cloudflare's own dashboard covers request-rate/error graphs).
- Per-account stats pages, even for the account's own owner — that's a
  product feature (inbox size in the UI), not this page's job.
- Alerting/thresholds. `/stats` is for humans looking, not machines paging
  someone.
