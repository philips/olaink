# Issue #5 — historical: Plugin Manager configuration button

Issue: <https://github.com/philips/wrtn/issues/5>

Completed 2026-08-23 for the prior SwapNote page-relay prototype. It registered
a Plugin Manager entry to expose relay URL and generated-username settings.

The current design supersedes that setup UI: account authentication, pairing,
device keys, encrypted whole-note delivery, and inbox/playback belong to the
WRTN companion PWA. The Supernote plugin is an in-note Share launcher. Retain
only the SDK registration/lifecycle knowledge if a companion-launch settings
entry is needed; do not preserve the old relay configuration surface.

See [`issue-15-e2ee-note-service.md`](issue-15-e2ee-note-service.md).
