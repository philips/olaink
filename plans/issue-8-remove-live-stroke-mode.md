# Issue #8 — Remove live stroke mode

## Goal

Make the prototype SwapNote-only. Remove the realtime collaborative-stroke
experiment end-to-end while preserving direct whole-page transfer, offline
mailbox delivery, automatic append to sender-specific INBOX notes, and the
`swaptest` receive-path test bot.

Issue: <https://github.com/philips/wrtn/issues/8>

## Scope decisions

- Pages are sent **directly to a typed username**, rather than to members of a
  collaboration session. A valid recipient may be offline; the existing page
  mailbox buffers the delivery.
- Retain identity registration, token authentication, HTTP long polling,
  `page.send`, `pages.ack`, and ping/pong.
- Retain the `swaptest` virtual sender and its test endpoint. Remove `echo`.
- Do not bump the protocol version: the retained page wire format is unchanged;
  newly removed message types are ignored by the simplified server.
- Keep one headless WRTN toolbar entry so receiving/auto-appending works with
  no setup view mounted. Remove the pull toolbar entry and its icon.

## Work plan

1. **Prune protocol surface**
   - In `packages/protocol/src/envelope.ts`, remove `join`, session-management,
     and `strokes` envelope variants; remove `echo` from reserved names.
   - In `packages/protocol/src/messages.ts`, remove session and live-stroke
     payloads, guards, and `PayloadMap` entries. Keep page stroke/text element
     types because they encode complete-page ink.
   - Update protocol and username tests to cover only retained message types,
     page validation, and `server`/`swaptest` reserved names.

2. **Simplify server routing and state**
   - Remove sessions, membership events, `ECHO`, and all echo/stroke routing
     from `packages/server/src/registry.ts` and `router.ts`.
   - Keep user records, authentication, long-poll delivery, expiry, direct page
     mailboxes, and acknowledgement behavior.
   - Simplify `WrtnServer` construction and peer diagnostics to no longer
     expose session data. Remove stale exports and descriptions.
   - Delete session/echo tests; retain and extend direct page-send, offline
     mailbox, reconnect/redelivery, ack, and `swaptest` tests.

3. **Remove plugin live-mode behavior**
   - In `packages/plugin/src/core/wrtnCore.ts`, remove pen-up capture, incoming
     stroke queues, manual pull, loop suppression, member state, invites, and
     echo onboarding.
   - Preserve page serialization, incoming-page deduplication/queueing,
     sender-note creation, automatic append on transport ticks, and page acks.
   - Validate typed page recipients before sending. The UI must not require a
     session or online peer for a page transfer.
   - Reduce the device bridge and its Supernote/stub adapters by removing
     pen-up, last-element, pull-button, and dead plain-stroke insertion APIs;
     retain geometry and element APIs required to serialize/render pages.

4. **Revise plugin controls and UI**
   - Remove the WRTN Pull button, button id, pull asset, listener, and
     `setButtonState` integration; retain a headless WRTN delivery control.
     (The Plugin Manager config button later replaced the toolbar setup view.)
   - Replace the session/invite/member and pending-stroke UI with a recipient
     username field plus a Send-current-page action, page-pending status, and
     SwapNote-only explanatory text.
   - Update plugin metadata to say it exchanges pages, not live strokes.

5. **Refresh documentation and verify**
   - Rewrite `README.md`, `plans/supernote-plugin.md`, `AGENTS.md`, and related
     descriptions so SwapNote is the only product surface. Preserve device
     research that remains applicable to page serialization and append.
   - Run `npm test` and `npm run typecheck`.
   - Build/deploy the plugin and verify on-device: send a page to a typed user,
     receive an offline page after reconnect, auto-append it when the matching
     SwapNote is open, and confirm an ack empties the server mailbox.

## Implementation status

Completed 2026-08-23:

- Protocol, relay, plugin core, device bridges, toolbar, setup UI, tests, and
  documentation were reduced to the SwapNote page-transfer surface.
- The Pull control and its asset were deleted. The remaining SwapNote button
  starts delivery and opens the pending-pages inbox (added subsequently).
- Verification passed: `npm run typecheck`, `npm test` (68 tests), and
  `npm run build:plugin`.
- On-device deployment remains the final manual validation step.

## Acceptance criteria

- No live-stroke/session/echo message types, routing, toolbar controls, or
  plugin core paths remain.
- A user can send the open page to a valid typed username without creating a
  session or requiring that recipient to be online.
- Received pages still append exactly once to
  `/storage/emulated/0/INBOX/swapnote-<sender>.note` and are acknowledged only
  after a successful write.
- `swaptest` remains usable for single-device receive-path testing.
- Unit tests and typechecking pass.
