# 14-day message retention

Status: **implemented**, per the decisions below.

- Retention clock starts at **send time** (confirmed).
- Worker Cron Trigger / standalone interval cadence: **every 6 hours**
  (confirmed; the doc below originally proposed hourly).
- Multi-device behavior: **global per-note expiry**, not per-delivery-row
  (confirmed).

The rest of this document is the design as built, kept for reference.

## Problem

Today an undelivered note lives on the relay forever. A note is deleted only
when every device in its recipient's directory has acknowledged it (or when a
device that held the last pending delivery is unregistered) — see `send()` /
`acknowledge()` / `unregisterDevice()` in `prototypeNoteRelay.ts`. If a
recipient device never polls again (lost Supernote, an abandoned Pi pairing,
an account nobody checks), its queued notes — and their R2 ciphertext — sit
in storage indefinitely. That is an unbounded storage/privacy liability and an
implicit, undocumented promise ("we keep your undelivered note forever") that
Ola Ink should not be making.

## Goal

Bound how long the relay holds an undelivered note: **14 days after it was
sent, an unacknowledged note and its ciphertext are deleted automatically,
regardless of delivery state.** No admin override, no extension, no recovery.

## Non-goals (explicitly out of scope for this change)

- Sender notification when a note expires unread. The relay has no push
  channel today (`plans/push-delivery-durable-objects.md` is parked); adding
  one just for expiry notices is a separate project.
- Retention/cleanup of `prototype_pairings` (already filtered by
  `expires_at` at claim time) or `prototype_device_sessions`/
  `prototype_devices` (account/device lifecycle, not message lifecycle).
- Per-account or per-note configurable retention. One fixed policy for every
  note.
- Changing delivered-note behavior. A note already acknowledged by every
  device in its recipient's directory is deleted immediately today, long
  before 14 days would ever matter — this plan does not touch that path.

## Policy (exact semantics to document and hold to)

- The clock starts at **send time** (`prototype_notes.created_at`, already
  stored), not last-poll time and not per-recipient-device delivery time.
- Applies identically to every relay-held note: browser inbox (`/v1/notes`
  → `/v1/poll` → `/v1/ack`) and companion/device (`/v1/companion/notes` →
  `/v1/companion/poll` → `/v1/companion/ack`) paths share one `prototype_notes`
  table, so one sweep covers both.
- **Practical effect is "undelivered-message retention," not "message
  retention."** A note that every recipient device has already acknowledged
  is already gone (see Non-goals). The 14-day clock only ever matters for a
  note that is still waiting on at least one device.
- Multi-device consequence to call out prominently in the docs: if a
  recipient has two paired devices and only one polls before day 14, deleting
  the note also cascades away the still-pending delivery row for the device
  that never checked in — that device permanently loses the note, even though
  a sibling device already received it. This is the intended trade-off of a
  hard per-note deletion instead of a per-delivery one (the alternative,
  expiring only stale per-device delivery rows while the note has other live
  deliveries, adds real complexity for a case — one device silently losing a
  note it was rightfully sent — that is no worse than the device never
  existing at all from the sender's point of view).

## Design

### Data model: no migration required

`prototype_notes.created_at` (epoch ms, set in `enqueue()`) is exactly the
timestamp the policy is defined against. No new column, no new table.

### Relay: a purge method, not a bigger `acknowledge`

Add to `D1Store` (`d1Store.ts`), mirroring the existing `poll`/`acknowledge`
shapes and the opportunistic-cleanup style already used by
`D1PairingClaimLimiter`:

```ts
/** IDs of notes older than cutoff, oldest first, capped at limit. */
async expiredNoteIds(cutoff: number, limit: number): Promise<string[]> {
  const rows = await this.db.prepare(
    'SELECT id FROM prototype_notes WHERE created_at < ? ORDER BY created_at LIMIT ?',
  ).bind(cutoff, limit).all();
  return rows.results.map((row) => row['id'] as string);
}

/** Deletes note rows by ID; FKs cascade to prototype_note_deliveries. */
async deleteNotes(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await this.db.batch(ids.map((id) => this.db.prepare('DELETE FROM prototype_notes WHERE id = ?').bind(id)));
}
```

Add to `PrototypeNoteRelay` (`prototypeNoteRelay.ts`), reusing the existing
best-effort `collect()` payload GC:

```ts
/**
 * Deletes notes older than maxAgeMs, regardless of delivery state, in
 * batches. R2/payload deletion happens before the D1 row delete, so a
 * mid-sweep failure leaves the same "row present, payload missing" state
 * poll() already tolerates (logs and skips) — safe to retry next sweep.
 */
async purgeExpired(maxAgeMs: number, batchSize = 500, maxBatches = 20): Promise<number> {
  const cutoff = this.now() - maxAgeMs;
  let purged = 0;
  for (let i = 0; i < maxBatches; i++) {
    const ids = await this.options.store.expiredNoteIds(cutoff, batchSize);
    if (ids.length === 0) break;
    await this.collect(ids); // payloads first — see doc comment above
    await this.options.store.deleteNotes(ids);
    purged += ids.length;
    if (ids.length < batchSize) break;
  }
  return purged;
}
```

`OlainkApp` (`handler.ts`) gains a thin pass-through, `runRetentionSweep()`,
calling `this.notes.purgeExpired(NOTE_RETENTION_MS)`, and
`OlainkAppOptions` gains an optional `noteRetentionMs` (default 14 days) so
tests can use a short window instead of monkeypatching `now`.

### Idempotency and concurrency

`deleteNotes` is a plain `DELETE ... WHERE id = ?`; running it twice (two
overlapping sweeps, a retried Cron invocation) is a no-op the second time, and
R2 `delete` on an already-missing key is not an error. No lock is needed —
this matches the accepted-race posture `collect()` already has.

### Wiring: Cloudflare Worker

`wrangler.jsonc` gains a Cron Trigger (top-level and in `env.staging`):

```jsonc
"triggers": { "crons": ["17 */6 * * *"] } // every 6 hours, off the hour
```

`worker.ts` gains a `scheduled` export, using the repo's existing pattern of
small structural types instead of pulling in `@cloudflare/workers-types` (see
`cloudflare-test.d.ts` for precedent):

```ts
interface ExecutionContextLike { waitUntil(promise: Promise<unknown>): void }

export default {
  fetch(request: Request, env: Env): Promise<Response> { /* unchanged */ },
  scheduled(_event: unknown, env: Env, ctx: ExecutionContextLike): void {
    ctx.waitUntil(appFor(env).runRetentionSweep());
  },
};
```

The 6-hour cadence keeps any single run small (the batch/max-batches cap
above bounds worst-case work) and keeps "how stale can an expired note get
before it is actually purged" well under a day.

### Wiring: standalone binary

`standalone.ts`/`main.ts` gains an in-process interval (every 6 hours,
`setInterval`, plus one run shortly after startup so a long-stopped process
catches up). Each `setInterval` firing is fire-and-forget with its own
`.catch()`, so a slow or failed run logs and does not throw out of the timer;
unlike the Worker there is no `waitUntil` to await, and Bun's timer fires on
schedule regardless. For self-hosted operators who would rather use an
external cron/systemd timer than an always-on interval, `olaink-server
--retention-sweep-once` runs one sweep against `--database`/`--notes` and
exits — same code path (`runRetentionSweepOnce` in `standalone.ts`), just
invoked once instead of on a timer.

### Observability

Log a one-line summary per sweep through the existing `log` callback
convention (counts and record IDs only — never plaintext, matching the
existing "do not log a record" rule in `handler.ts`):
`[olaink-relay] retention sweep purged N note(s) older than <cutoff>`.

## Testing plan

- `d1Store` / `prototypeNoteRelay` unit tests (added to
  `prototypeNoteRelay.test.ts`, which is in `portableServerSuites` and so
  runs against both the Node SQLite shim and real Miniflare D1/R2): enqueue a
  note with a fabricated old `now`, enqueue a fresh one, run `purgeExpired`
  with a later `now`; assert the old note's D1 row, its delivery row(s), and
  its R2/payload object are gone, the fresh note is untouched, and a
  subsequent `poll()`/`acknowledge()` for the purged ID behaves like "already
  gone" rather than erroring.
- Batch-cap test: seed more expired notes than one `batchSize`, assert one
  `purgeExpired` call with a small `maxBatches` purges only up to the cap and
  a second call finishes the rest (proves the "next sweep picks up the
  remainder" claim).
- Idempotency test: call `purgeExpired` twice in a row over the same expired
  set; second call purges 0 and does not error.
- `handler.test.ts`: `OlainkApp` constructed with a short `noteRetentionMs`,
  send a note via the fetch surface, advance `now`, call
  `runRetentionSweep()`, assert `/v1/poll` (or `/v1/companion/poll`) no
  longer returns it.
- Standalone: a `standalone.test.ts` case for the one-shot CLI flag (or the
  interval, with a fake timer) analogous to existing standalone coverage.

## Rollout

1. Land the D1Store/relay/handler changes + tests (no behavior change yet —
   `runRetentionSweep()` exists but nothing calls it).
2. Land the Worker `scheduled` export + `wrangler.jsonc` cron trigger, and
   the standalone interval/CLI flag.
3. Deploy to `olaink-staging` first; confirm a hand-seeded old-`created_at`
   test note in staging is purged on the next scheduled run, and that
   `/commit`-style manual smoke checks show no regressions.
4. Deploy to production. No data migration needed; existing old rows simply
   become eligible for the next sweep (the first production sweep after
   deploy may purge a backlog of already-old notes — expected and desired).
5. Publish the website/docs updates (below) at the same time as the
   production deploy, not before — don't promise a policy that isn't live
   yet.

## Website & documentation updates

### `docs/message-retention-policy.md` (new, mirrors `docs/account-policy.md`'s terse style)

```markdown
# Ola Ink message retention policy

- A note not yet acknowledged by every device it was sent to is deleted
  automatically 14 days after it was sent, along with its encrypted content.
  There is no way to recover it after that, for support or otherwise.
- A note already acknowledged by every device in its recipient's directory is
  deleted immediately, well before the 14-day window would apply.
- The 14-day clock runs from send time, not from when a recipient last
  checked their inbox.
- If a recipient has more than one paired device and only some of them poll
  before day 14, the note is still deleted for all of them at day 14 —
  including a device that never got a chance to receive it.
```

Cross-link this new file from `packages/server/README.md`'s "Browser inbox
data and loss" section (rename the section "Data retention and loss" and add
a subsection), the same way `docs/account-policy.md` is already linked from
the "Backups and restore" section.

### Public site: new `/privacy/` page

The site currently has only `index.astro` and `install.astro` — no page owns
data-handling claims yet, and this is a real, linkable promise worth a stable
URL (it will be referenced from onboarding and from the Pi plugin README).
Add `packages/site/src/pages/privacy.astro`, built with the existing
`olaInkHeader`/`olaInkNavLink` shell (`packages/ui/src/templates.mjs`) and
site design system, containing plain-language copy such as:

> **How long Ola Ink keeps a note**
>
> Ola Ink only ever stores encrypted note content — never plaintext strokes,
> text, or filenames. A note is deleted from the relay as soon as every
> device you sent it to has received it. If a note is never received by all
> of its recipient's devices, it is deleted automatically **14 days** after
> you sent it — there is no way to recover it after that. If you use more
> than one device (for example, a Supernote and a Pi agent) and only one of
> them checks its inbox before then, the note is still removed for all
> devices at day 14.

Add a link to `/privacy/` in the shared header navigation on `index.astro`
and `install.astro`, and one sentence pointing to it from the homepage's
"Ola Ink for Pi" section, since an unattended agent inbox is the most likely
place someone hits the 14-day boundary in practice.

### `packages/pi-plugin/README.md`

Add one line to "Local security and behavior" noting that an unpolled note is
deleted by the relay after 14 days, linking to `/privacy/`, since a Pi agent
is the device most likely to go unpolled for that long.

## Implementation notes (as built)

- `D1Store.expiredNoteIds` / `deleteNotes` (`d1Store.ts`), `PrototypeNoteRelay.purgeExpired`
  (`prototypeNoteRelay.ts`), `OlainkApp.runRetentionSweep` / `noteRetentionMs`
  (`handler.ts`, default `NOTE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000`).
- Worker: `scheduled()` export in `worker.ts` (structural `ExecutionContextLike`,
  no `@cloudflare/workers-types` dependency); `triggers.crons` in
  `wrangler.jsonc` (top-level and `env.staging`).
- Standalone: `retentionSweepIntervalMs` option (default 6h, `0` disables) and
  `runRetentionSweepOnce()` in `standalone.ts`; `--retention-sweep-once` CLI
  flag in `main.ts`.
- Tests: `prototypeNoteRelay.test.ts` (`purgeExpired` deletion, batching/cap,
  idempotency — runs against both the SQLite shim and Miniflare D1/R2),
  `handler.test.ts` (`runRetentionSweep` over the real HTTP send/poll surface),
  `standalone.test.ts` (`runRetentionSweepOnce` against an on-disk database).
- Docs: `docs/message-retention-policy.md` (new), `packages/server/README.md`
  "Data retention and loss" section (renamed from "Browser inbox data and
  loss"), `packages/site/src/pages/privacy.astro` (new, linked from the
  homepage and install page nav and from the homepage's Pi section),
  `packages/pi-plugin/README.md`.
