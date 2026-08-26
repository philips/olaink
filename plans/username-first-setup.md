# Username-first account setup

## Status

Phase 1 shipped: account creation asks for the username first and uses it as
the client-side WebAuthn `user.name`/`user.displayName` label before
`navigator.credentials.create()`. No server changes. Usernames are presented
bare (no `@` prefix) everywhere in the UI. The post-registration
claim form (prefilled with the typed name) remains the authoritative
assignment and the fallback when a name is taken mid-ceremony; in that race
the passkey label can be wrong, which is accepted for now.

The reservation design below is deferred phase 2.

## Problem

The current root setup creates an AuthGravity passkey first and asks for the
permanent Ola Ink username only after authentication. AuthGravity deliberately
returns `user.name` and `user.displayName` as `Me`; its integration guide says
the application may replace those fields **in the client** before
`navigator.credentials.create()`. The replacement is passkey-label metadata
only and is never sent to AuthGravity.

As a result, a person who creates multiple Ola Ink accounts sees several
indistinguishable `Me` passkeys even though every Ola Ink account has a
permanent public username.

## Outcome

A new-account setup starts with an immutable `@username` selection. The
creation ceremony uses the canonical `@username` for both WebAuthn `user.name`
and `user.displayName`. The username is then atomically assigned to the newly
authenticated Ola Ink account before a browser inbox key or companion pairing
can be created.

This concerns browser account creation only. Login remains a separate path and
Android remains a paired companion; neither asks for, nor can change, a
username.

## Design

### 1. Reserve the requested username before the passkey ceremony

A simple availability check is insufficient: another person could claim the
name between the initial form and the post-registration claim, leaving a
passkey labelled with the wrong name. Add a short-lived, one-use **unclaimed
username reservation**:

- `POST /v1/onboarding/username-reservations { username }` normalizes and
  validates the name, rejects active, retired, or currently reserved names,
  and returns an opaque 256-bit reservation token plus the canonical username.
- Store only a SHA-256 token digest, canonical username, issue/expiry time
  (10 minutes), and no AuthGravity subject. A reservation expiry releases the
  *unclaimed* name; it never changes the permanent-name/no-reuse rule.
- Deliver the raw token in a Secure, HttpOnly, SameSite=Lax cookie scoped to
  `app.olaink.com`. Do not put it in the URL, localStorage, AuthGravity request,
  or WebAuthn credential.
- Rate-limit this unauthenticated endpoint by a proxy-aware client key and
  clean expired rows opportunistically and at startup. This prevents it being
  used to squat on names.

After AuthGravity has verified registration, the root page calls
`POST /v1/onboarding/username-reservations/claim`. The server authenticates
with AuthGravity, reads and consumes the reservation cookie in the same
transaction, and creates the normal immutable username assignment. It must
return the same account payload as `POST /v1/account/username`.

Keep `POST /v1/account/username` for already-authenticated legacy,
unconfigured accounts. It must not accept a reservation token or client-supplied
account ID.

### 2. Change the root setup state machine

Update `packages/server/public/onboard.html` (then regenerate
`src/onboardPage.ts`) to use these states:

1. **Signed out, create account:** show the username field, syntax/permanence
   copy, and `Continue with passkey`; retain `Log in` as a separate action.
2. **Continue:** validate locally, acquire the reservation, request
   `/v1/register/options`, clone the returned options, and set
   `options.user.name` and `options.user.displayName` to the canonical
   `@username` label immediately before calling `navigator.credentials.create()`.
3. **Verified:** immediately claim the reservation, then create the browser
   inbox key as today.
4. **Cancelled/failed passkey ceremony:** keep the form and reservation until
   expiry; let the user retry with the same name. Allow returning to name
   selection, which explicitly releases the current reservation.
5. **Signed out, log in:** do not display a username chooser. After login,
   preserve the current account-state behavior: named accounts open their
   inbox; legacy unconfigured accounts see the existing claim form.

Explain before the button: “This will also be the label shown for this Ola Ink
passkey on your device.” Keep the existing irreversible-username confirmation.
Never imply the AuthGravity passkey itself owns the public username.

### 3. Persistence and server wiring

- Add a SQLite `username_reservations` table and store methods in
  `packages/server/src/prototypeSqliteStore.ts`; use a unique canonical-name
  constraint and an atomic `claimReservedUsername` transaction with
  `account_usernames`.
- Add reservation routing and cookie parsing/serialization to
  `packages/server/src/httpApi.ts`. The normal username claim and reservation
  claim must share normalization, reserved-name validation, and immutable
  ledger logic from `accountUsernames.ts`.
- Never expose reservation existence through a directory endpoint. Return a
  generic unavailable response for active, retired, and reserved names.
- Update the generated root asset with `node scripts/embed-onboard-page.mjs`;
  `packages/server/src/onboardPage.ts` is generated and must not be edited by
  hand.

## Tests and acceptance

1. Unit-test normalization, expiry, release, concurrent reservation attempts,
   and atomic reservation-to-permanent-assignment conversion.
2. HTTP-test that reservation creation is rate-limited, raw tokens never appear
   in a response body/loggable URL, a missing/expired/cross-browser cookie
   cannot be claimed, and an authenticated account cannot claim another
   reservation.
3. Root-page tests should assert the username form precedes registration and
   that the options passed to `navigator.credentials.create()` contain the
   canonical username label while the request sent to AuthGravity remains the
   unchanged credential response.
4. Manual browser validation: create two accounts such as `@mira` and `@kai`;
   the OS/browser passkey picker displays distinguishable Ola Ink labels;
   login still works for both; cancelled setup does not permanently burn a
   username after its reservation expires.
5. Run `npm run typecheck`, `npm test`, and the normal embedded-page/build
   checks. Confirm pairing still requires a successfully claimed username.
