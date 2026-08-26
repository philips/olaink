# Historical cleanup — SwapNote and WRTN prototypes

Completed. The obsolete plaintext page-transfer implementation and old companion
identity have been removed from the active source tree.

- The Supernote plugin is an Ola Ink Share launcher only. It sends an opaque
  launch identifier, never a note path, note bytes, account data, or keys.
- The page-relay protocol, polling transport, mailboxes, test generator,
  element extraction/reconstruction code, and their SDK stub have been deleted.
- The server retains only encrypted whole-note storage, pairing, and crypto
  components. The remaining prototype authorization work is documented in
  [`usernames.md`](usernames.md) and [`inbox.md`](inbox.md).
- The old companion wording, migration documents, package metadata, and stale
  workspace links have been removed. The retained Android wrapper and pinned
  viewer are Ola Ink components.

Do not restore compatibility routes or any plaintext note-content transport.
The supported source-file hand-off remains the release gate described in
[`issue-15-e2ee-note-service.md`](issue-15-e2ee-note-service.md): until a
scoped `content://`, Storage Access Framework, or reviewed native boundary is
proven, Share must fail closed with respect to the active note.

Published Git history is intentionally not rewritten. Historical issue branches
should be deleted remotely after normal merge/release review; they are not a
supported source of product code.
