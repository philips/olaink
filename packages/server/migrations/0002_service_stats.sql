-- Aggregate-only support for GET /stats (see plans/service-stats.md):
--
--   * prototype_notes.size_bytes: the ciphertext JSON byte length of the
--     record, captured once at enqueue time. This lets current/pending
--     storage totals and the per-account distribution be computed with SQL
--     alone -- no R2 bucket listing, no reading record contents.
--   * service_counters: a tiny key/value table for lifetime counters
--     (messages ever sent, bytes ever sent) that survive delivery
--     acknowledgement and the 14-day retention sweep, both of which delete
--     the corresponding prototype_notes row.
ALTER TABLE prototype_notes ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;

CREATE TABLE service_counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
