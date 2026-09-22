## Supernote: adb over Wi-Fi

The device firmware exposes no adb-over-Wi-Fi switch in the Supernote
Settings app, but it's stock Android 11 underneath — the real Android
Settings are reachable, and its "adb over WiFi" option is **persistent**
(fixed port **5555**, survives reboots).

One-time setup (needs USB once, with USB debugging already enabled — the
Supernote has its own ADB toggle behind a user agreement in Settings):

1. `adb shell am start -a android.settings.SETTINGS`
   — opens the **real Android settings** page
2. **About tablet** → tap **Build number** 10× (unlocks Developer options)
3. **System → Advanced → Developer options** → enable **adb over WiFi**
4. If the connection won't establish, toggle **USB debugging** off and on
5. Unplug USB, then on the dev machine:

   ```sh
   adb connect <device-ip>:5555
   ```

   The device IP can be the LAN address or its Tailscale address
   (e.g. `100.103.149.40:5555`).

### Recovery: `Connection refused` on port 5555

If the Supernote is reachable on the network but `adb connect <device-ip>:5555`
reports `Connection refused`, reconnect it over USB and force the currently
running `adbd` into TCP mode before unplugging:

```sh
adb tcpip 5555
adb connect <device-ip>:5555
```

This is a recovery step for a device whose persistent **adb over WiFi** setting
did not start the listener. It requires an already-authorized USB ADB session;
repeat it after a reboot if the listener is again absent.

Fallback (older path, still works): over USB run
`adb shell settings put global adb_wifi_enabled 1`, accept the popup —
but that path uses a **random port that changes on every enable**, so you
have to port-scan the device each time (e.g.
`masscan -p1-65535 <ip> --rate=1000 -e wlan0`). Prefer the persistent
port-5555 path above.

Context: the Supernote's USB connection is flaky for many users (not
recognized, driver fails, adb drops after seconds) — Wi-Fi adb is the
stable debug link. See [r/Supernote: enabling adb over wifi](https://www.reddit.com/r/Supernote/comments/1ifxw9h/enabling_adb_over_wifi/).

With adb connected, see `AGENTS.md` for the plugin dev loop
(`scripts/snplg-deploy.sh`, `scripts/snplg-logs.sh`).


The architecture and migration plan are in
[`plans/issue-15-e2ee-note-service.md`](plans/issue-15-e2ee-note-service.md).

## Layout

```
packages/
  plugin/     the single Supernote .snplg (React UI + NPK crypto/files)
  server/     encrypted whole-note relay and pairing service (app.olaink.com)
  site/       public website
plans/         architecture and device research
scripts/      Supernote plugin ADB helpers
```

## Development

```sh
npm install
npm test
npm run typecheck

# Current plugin development loop
adb connect 100.103.149.40:5555
npm run deploy:plugin
npm run logs
```

### Server tests and local runtimes

The server is one fetch handler (`packages/server/src/handler.ts`) with two
entry points: the Cloudflare Worker (`src/worker.ts`) and the self-host binary
(`src/main.ts` → `Bun.serve`). `npm test` runs two vitest projects:

- `node` — every suite, against the standalone path (SQLite D1 shim,
  in-memory or directory payloads);
- `workers` — the portable suites again inside workerd, against Miniflare D1
  and R2 bound from `packages/server/wrangler.jsonc` (no Cloudflare account
  needed). `src/testApp.ts` is aliased to `src/testApp.workers.ts` there.

Bun-only suites (`bun:sqlite`, `Bun.serve`) run with
`npm run test:bun -w @olaink/server`. Local servers:

```sh
npm run server                              # standalone, ./olaink.sqlite
cd packages/server
npx wrangler d1 migrations apply olaink --local
npx wrangler dev                            # Worker with local D1/R2 (.wrangler/)
```

## Pinned `supernote-viewer.js` web component

The `<supernote-viewer>` web component used by the server's browser inbox is
**not** vendored from source here. A built bundle from the upstream
`philips/supernote-obsidian-plugin` repo is pinned as a checked-in asset:

- `packages/server/public/supernote-viewer.js` — the pinned bundle (served by
  the relay and embedded into the self-contained server binary)
- `packages/server/scripts/update-pinned-viewer.sh` — records the pinned
  upstream commit and SHA-256 checksum, rebuilds the asset, and regenerates
  the embedded server files
- `packages/server/README.md` — the pin table (commit, patch, checksum)

The pin currently points at upstream commit `e60d7c5` (PR #252) and carries
one local patch: the stroke-animation paint cap is sed-edited from 30 to 10 FPS
so the Nomad's E-Ink panel is not asked to refresh faster than it can show.
Browser playback uses the viewer's `static`/`write-on-paused` presentation
modes to avoid E-Ink scrolling animations. The script fails
if the minified FPS constant it expects is no longer present, so an upstream
rebuild that changes it can never be applied silently.

### Updating the pin

From a recursive clone of upstream at the new commit:

```sh
packages/server/scripts/update-pinned-viewer.sh /path/to/supernote-obsidian-plugin
```

The script builds upstream's `supernote-typescript` submodule, runs
`npm run build:webcomponent`, verifies and applies the 10 FPS patch, copies
the bundle into `packages/server/public/`, checks it against `VIEWER_SHA256`,
and regenerates the server's embedded files. An update is a deliberate,
reviewable change: the commit, the patch behavior, the checksum, and the
README pin table must be reviewed together. Bump both `UPSTREAM_COMMIT` and
`VIEWER_SHA256` in the script (compute the new checksum with `sha256sum`
after patching) and update the table in `packages/server/README.md`.

Because the browser inbox embeds the same asset, the server's embedded copy
must be refreshed too. This is automated: the update script runs the embed
step, `npm test` regenerates the embedded files before running (a `pretest`
hook), CI rejects stale ones (`npm run check:generated`), and
`npm run build:server[:arm64]` regenerates before compiling.

The compiled server binary also bakes the deploy commit in at build time
(`scripts/build-server.mjs` passes it to `bun --define`; there is no committed
`buildInfo.ts` value to keep stashing).

Features are validated upstream before pinning: run upstream's own suite
(`npx vitest run src/webcomponent/SupernoteViewerElement.test.ts`) against a
checkout of the pinned commit. Host integration notes for the component
itself (e.g. the `autoplay` attribute's strict `<num>x` format and its
interaction with the `presentation` property) live in upstream's
`webcomponent-usage.md`.
