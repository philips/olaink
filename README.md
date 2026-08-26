# olaink

Ola Ink privately exchanges complete Supernote `.note` files.

## Architecture

- **Supernote plugin:** an in-note **Share** affordance. It launches the
  separately installed Ola Ink Android application for the active note; it does
  not serialize strokes, encrypt, poll, receive, or append notes.
- **Ola Ink Android application:** a native Android WebView wrapper around the
  Ola Ink PWA. The PWA owns AuthGravity pairing/account authentication, IndexedDB
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
[`android`](android).

## Layout

```
packages/
  plugin/     Supernote Share plugin
  server/     encrypted whole-note storage and pairing service
android/       native Android WebView/player hand-off fixture
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

The Android companion is a separate Gradle project; see
[`android/README.md`](android/README.md) for build, install, and on-device
viewer validation. Its source assets are pinned and reproducible; do not commit
its `build/` or `.gradle/` outputs.

## Current migration status

The plugin is launch-only: it does not read the open note, and it will not send
one until a supported `content://`, Storage Access Framework, or reviewed native
source-file hand-off has been proven. `@olaink/server` provides a deployable encrypted whole-note service with
AuthGravity account/device-bound operations, immutable username routing,
SQLite-backed opaque record delivery, and per-device acknowledgement. Its root
page enrolls a browser-only inbox key in IndexedDB, decrypts received whole
notes locally, and uses the pinned Supernote viewer to replay them. Build one
self-contained Bun binary with `npm run build:server`; it listens on port
`8002` by default and persists to `OLAINK_DATABASE` (or `./olaink.sqlite`). See
[`packages/server/README.md`](packages/server/README.md) for deployment.
