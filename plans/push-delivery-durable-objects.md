# Push delivery (Durable Objects) — parked follow-up

Filed from the Cloudflare migration plan
([`migrate-to-cloudflare.md`](migrate-to-cloudflare.md), Q6) so the question
doesn't get lost. The migration deliberately keeps polling; this is the
post-migration upgrade path for delivery latency.

## Problem

Recipients receive notes by polling `POST /v1/poll` on an interval. Consequences:

- A sender's note is visible only after the recipient's next poll — latency is
  bounded by the poll interval, not by network delivery.
- Every poll costs a request; on the Workers free plan that is 100k requests/
  day account-wide, so aggressive polling on many devices burns budget.
- Devices that are asleep/offline only learn about deliveries when they next
  wake and poll (which is correct, but there is no "catch up fast" signal).

## Sketch (not scoped — do not implement from this document)

- One Durable Object per recipient device (or per account) on Cloudflare.
- Send path: after the delivery rows are persisted in D1 and the payload in R2
  (existing `send` flow, unchanged), the handler `ctx.waitUntil`s a stub
  fetch to the recipient's DO to wake it.
- The client opens a WebSocket (SSE as a fallback) to the DO. On wake, the DO
  reads the pending deliveries from D1 (the source of truth) and streams
  record IDs — or full records for small notes — to the connected client.
- **Polling stays as the universal fallback.** If the socket is unavailable
  (offline, WebView quirks on the Nomad, cold start), the client uses
  `/v1/poll` exactly as today. The DO only *notifies*; the record still flows
  through the existing send → poll → ack contract, so ack dedup and R2 GC
  semantics are unchanged (at-least-once delivery, acked exactly once).
- Auth: the socket upgrade carries the same capability the poll path uses —
  AuthGravity session for the browser inbox, `x-olaink-device-session` for the
  companion. No new trust surface, no new endpoint semantics.
- E2E invariant: the DO and the relay never see plaintext; the socket carries
  record IDs and, at most, opaque ciphertext.

## Open questions (answer when this gets scoped)

- WebSocket through Cloudflare on the free plan: connection duration limits
  and reconnect/backoff behavior; confirm Nomad WebView + browser handling
  (the companion's pinned-viewer page has its own lifecycle quirks).
- DO state vs D1: recommendation is D1 remains the only queue; the DO holds
  at most "who is currently connected" (ephemeral, reconnect-safe).
- Cost model: DO state storage, invocations, and WebSocket egress on free vs
  paid tiers; poll-interval tuning once push exists (wider poll interval as a
  safety net).
- Ordering/reconnect guarantees: re-read from D1 on (re)connect, rely on the
  existing ack for idempotency.
- Client work: this is a real protocol addition to the PWA inbox and the
  companion (unlike the migration, which was client-invisible) — it needs its
  own design pass, tests, and (for the companion) an APK release.

## Dependencies

- Cloudflare migration complete (Worker entrypoint, D1/R2 layout, D1 rate
  counter).
- A decision on Workers Paid vs free tier (DOs work on both; cost differs).
- Companion APK release process (see `android-apk-signing-and-dev-install.md`)
  if the Android WebView client participates.
