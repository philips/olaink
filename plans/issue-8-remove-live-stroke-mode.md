# Issue #8 — historical: remove live stroke mode

Issue: <https://github.com/philips/wrtn/issues/8>

Completed 2026-08-23. This change reduced an earlier collaboration prototype to
a plaintext SwapNote page-transfer implementation. That implementation is now
superseded by the whole-`.note`, Android-companion/PWA architecture in
[`issue-15-e2ee-note-service.md`](issue-15-e2ee-note-service.md).

Do not restore or extend its page/stroke relay, extraction, normalization,
auto-append, `page.send`, `pages.ack`, or `swaptest` paths. They are migration
removal targets, not supported product behavior.
