# wrtn

A service for exchanging handwritten messages between Supernote e-ink tablets.

A pen stroke drawn in an open note is captured by a **Supernote plugin**,
sent over HTTPS to a relay **server**, and rendered live into another user's
open note. A built-in **echo** bot mirrors your strokes (offset, gray) as an
end-to-end test.

**SwapNote** (issue #2) adds whole-page transfer: send your current page,
stroke and text-box fidelity, to another user. It lands as a new page in a
dedicated `/storage/emulated/0/INBOX/swapnote-<sender>.note` on the receiver's
 tablet (absolute path — the note app's `createNote` rejects relative paths;
 flat name since the SDK has no directory-creation API) and is
 auto-appended while that note is open. Pages buffer in the server's mailbox
when the receiver is offline and are deduplicated on redelivery. A
**swaptest** bot can generate pages on demand via
`POST /v1/test/swaptest/page`.

Verified on a Nomad A6X2; see [`plans/supernote-plugin.md`](plans/supernote-plugin.md)
for the full design record and on-device findings.

## Layout

npm-workspaces TypeScript monorepo:

```
packages/
  protocol/   versioned envelope + strokes/username codec, HTTP long-poll transport
  server/     zero-dep Node relay: registry, router, echo + swaptest, HTTP API
  sn-stub/    in-memory mock of sn-plugin-lib (unit-testable, no device)
  plugin/     the Supernote plugin (React Native bundle → .snplg)
scripts/      snplg-deploy.sh / snplg-logs.sh (adb over Wi-Fi)
```

## Prerequisites

- Node ≥ 22
- adb, with the device reachable (Wi-Fi or Tailscale):
  `adb connect 100.103.149.40:5555`
- A Tailscale Serve HTTPS endpoint fronting the server (cleartext HTTP is
  blocked by the plugin host): `sudo tailscale serve --bg 8001` →
  `https://<host>.ts.net`. Update `DEFAULT_SERVER_URL` in
  `packages/plugin/src/headless.ts` to match.

## Develop

```sh
npm install
npm test                 # vitest, 94 tests
npm run typecheck        # tsc -p tsconfig.json

npm run server           # relay on 0.0.0.0:8001 (proxied by Tailscale Serve)

# device loop
npm run deploy:plugin    # build .snplg, push, auto-install (stable pluginID)
npm run logs             # live plugin + host logcat
npm run logs:capture     # one-shot recent buffer, noise filtered
```

### Hot reload (no reinstall)

The plugin host ships a debug receiver that swaps the JS bundle in place (see
`plans/supernote-plugin.md` → "Hot reload"). One-liner after a code change:

```sh
npm run build:plugin && \
adb push packages/plugin/build/generated/wrtnplugin.bundle \
        /storage/emulated/0/MyStyle/wrtnplugin.bundle && \
adb shell am broadcast \
  -n com.ratta.supernote.pluginhost/.receiver.PluginReceiver \
  -a com.ratta.supernote.plugin.action.DEBUG -f 0x01000000 \
  --es bundle_path "/storage/emulated/0/MyStyle/wrtnplugin.bundle" \
  --es plugin_id "wrtnsync00000001"
```

## Status / honesty table

- ✅ monorepo, sn-stub, protocol, transport, server, echo transform
- ✅ plugin scaffold + headless session + capture/render (on-device)
- ✅ full echo round-trip on-device (stylus → server → echo → live render)
- ✅ SwapNote page transfer: send current page → receiver's SwapNote note,
  mailbox buffering while offline, auto-append + dedup (unit-tested AND
  exercised on-device: note created in INBOX, pages auto-append, acks clear
  the mailbox)
- ✅ `.note` config persistence: absolute MyStyle config note preserves
  username and server URL across headless-runtime restarts (on-device)
- ⚠️ echo render flashes the screen (full-page e-ink refresh per echo;
  `setTimeout`-based debouncing is unavailable in the runtime)

See `plans/supernote-plugin.md` → "v1 limitations".

## Technical philosophy

- TypeScript-first, strict; Vitest for unit tests.
- Unit-test everything against `sn-stub`; minimize manual on-device testing.
- Normalized `0..1` stroke coordinates on the wire; the device does geometry.
- Stable committed `pluginID` (reinstall = upgrade, not a new plugin).
- Use existing protocols (HTTP long-poll over TLS) and infrastructure
  (Tailscale) rather than building new ones.

## Planned

- A PWA to scan handwritten notes — see `plans/scanner-pwa.md`.
- LLM features via TPX (https://tokenpony.dev/llms.txt).

## Inspiration

https://en.wikipedia.org/wiki/Swapnote

## Developer notes

See [DEVELOPER.md](DEVELOPER.md) (adb-over-Wi-Fi setup) and
[AGENTS.md](AGENTS.md) (device facts + deploy/log scripts).
