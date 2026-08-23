# Supernote plugin — SwapNote

## Purpose

SwapNote transfers complete note pages between Supernote users. It intentionally
does not synchronize in-progress ink or note sessions.

A user enters a recipient username in the setup view and sends the current
page. The server stores it in the recipient's mailbox, including when the
recipient is offline. On receipt, the plugin creates (if needed) and appends to
`/storage/emulated/0/INBOX/swapnote-<sender>.note`. Mailbox entries remain
until the successful append emits `pages.ack`.

## Protocol and relay

Retained envelopes are `hello`, `welcome`, `page.send`, `pages.ack`, `ping`,
`pong`, and `error`. `page.send` carries normalized stroke points and normalized
text rectangles. Usernames are validated locally and by the server; `server`
and `swaptest` are reserved.

The relay keeps live user records for authenticated long polling and a separate
bounded page mailbox for each recipient. Dropping an expired user never drops
its page mailbox. `swaptest` is a server-side sender exposed through
`POST /v1/test/swaptest/page`.

## Plugin lifecycle

- The **WRTN config button** in Supernote Plugin Manager opens the React Native
  setup view for recipient entry, status, server URL configuration, and
  activity. Its native registration precedes listener registration and is
  idempotent per JS runtime.
- **SwapNote** (`showType: 0`) starts the headless runtime so long-poll delivery
  can continue while reading notes; it does not open a view.
- Closing a displayed plugin view stops its JS runtime, so the headless toolbar
  entry is required for background delivery.
- Configuration is persisted in an absolute-path `.note` file in MyStyle. The
  settings context cannot query note templates, so creation falls back to
  `style_white`.

## Page conversion

The sender reads the current page with `getElements`. Stroke points are
normalized using the sender's EMR dimensions; text bounds are normalized using
the page dimensions. On the receiver, normalized strokes are converted back to
EMR dimensions before `setRange`; text bounds use the inserted page size.

Device geometry verified on 2026-08-21:

| device | pixels | EMR |
| --- | --- | --- |
| A5X portrait | 1404×1872 | 15819×11864 |
| Nomad | 1920×2560 | 21632×16224 |

## Receive behavior

Incoming pages are deduplicated in memory and grouped by sender. The plugin
creates the sender's SwapNote note early, then appends queued pages only while
that note is open. It acknowledges only pages successfully inserted. Reconnect
redelivery is therefore safe, and pages remain available after plugin restart
until the server receives an acknowledgement.

## Device development

See the root [AGENTS.md](../AGENTS.md) for ADB deployment and log capture.
Build, install, and inspect with:

```sh
npm run typecheck
npm test
npm run deploy:plugin
npm run logs
```

On-device validation should cover typed-recipient send, offline delivery,
opening a sender SwapNote note, append, and acknowledgement clearing the relay
mailbox.
