# wrtn

WRTN privately exchanges complete Supernote `.note` files.

## Architecture

- **Supernote plugin:** an in-note **Share** affordance. It launches the
  separately installed WRTN Android application for the active note; it does
  not serialize strokes, encrypt, poll, receive, or append notes.
- **WRTN Android application:** a native Android WebView wrapper around the
  WRTN PWA. The PWA owns AuthGravity pairing/account authentication, IndexedDB
  device keys, end-to-end encryption, upload/download, and the inbox.
- **Viewer:** the PWA decrypts a full `.note` into an `ArrayBuffer` and passes
  it to the pinned `<supernote-viewer>` component. The component's native Play
  control handles write-on playback.
- **Service:** persists opaque encrypted file records and per-device delivery
  state. It never receives extracted strokes, text, a plaintext filename, or a
  content key.

The architecture and migration plan are in
[`plans/issue-15-e2ee-note-service.md`](plans/issue-15-e2ee-note-service.md).
The validated Nomad intent/WebView fixture is
[`experiments/wrtn-player-wrapper`](experiments/wrtn-player-wrapper).

## Layout

```
packages/
  plugin/     Supernote Share plugin
  protocol/   transitional protocol; replaced by encrypted whole-note records
  server/     transitional relay; replaced by authenticated opaque storage
  sn-stub/    Supernote SDK mock
experiments/
  wrtn-player-wrapper/  native Android WebView/player hand-off fixture
plans/        architecture and device research
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

The wrapper fixture is a separate Android/Gradle project; see its README for
build, install, and on-device viewer validation. Its source assets are pinned
and reproducible; do not commit its `build/` or `.gradle/` outputs.

## Current migration status

The checked-in TypeScript relay/plugin still implements the prior plaintext
page-transfer prototype. It is intentionally being replaced, not extended.
Do not add new stroke extraction, page reconstruction, or SwapNote inbox work;
put new delivery/account/crypto work on the PWA + companion-app path.
