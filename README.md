# wrtn

SwapNote is a Supernote plugin and relay service for exchanging complete
handwritten note pages. Enter a recipient's username, send the current page,
and it is appended to that recipient's dedicated
`/storage/emulated/0/INBOX/swapnote-<sender>.note` when they open it.

Pages retain strokes and text boxes, are buffered for offline recipients, and
remain in the server mailbox until acknowledged after append. The `swaptest`
endpoint can generate a sample page for a user.

Verified on a Nomad A6X2; implementation details and device findings are in
[`plans/supernote-plugin.md`](plans/supernote-plugin.md).

## Layout

```
packages/
  protocol/   versioned page-transfer envelope, username codec, HTTP polling transport
  server/     zero-dependency relay with page mailboxes and swaptest endpoint
  sn-stub/    in-memory sn-plugin-lib mock for unit tests
  plugin/     Supernote React Native bundle → .snplg
scripts/      ADB deploy and log helpers
```

## Develop

```sh
npm install
npm test
npm run typecheck
npm run server

npm run deploy:plugin
npm run logs
npm run logs:capture
```

The plugin host requires HTTPS. A Tailscale Serve endpoint can proxy the relay:
`sudo tailscale serve --bg 8001`. Set `DEFAULT_SERVER_URL` in
`packages/plugin/src/headless.ts` to that URL.

## How SwapNote works

1. Open the WRTN config button in Supernote Plugin Manager to enter the
   recipient username and configure the relay URL.
2. Tap **Send** to transfer the current page.
3. The recipient opens `swapnote-<sender>.note` in INBOX; queued pages append
   automatically and are acknowledged.
4. Use the headless **SwapNote** toolbar button to keep delivery active while
   reading notes.

`POST /v1/test/swaptest/page` sends a generated page to a valid username for
end-to-end testing.

## Principles

- TypeScript-first and strict, with Vitest and `sn-stub` coverage.
- Normalize coordinates to `0..1` on the wire; device bridges apply geometry.
- Keep a stable plugin ID so installs upgrade in place.
- Use TLS HTTP long polling and existing Tailscale infrastructure.

See [DEVELOPER.md](DEVELOPER.md) and [AGENTS.md](AGENTS.md) for device and
ADB workflow notes.
