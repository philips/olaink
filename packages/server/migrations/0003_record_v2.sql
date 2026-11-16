-- Record v2 (see plans/binary-record-transport.md): a small JSON routing
-- header plus the ciphertext stored as raw bytes.
--
--   * prototype_notes.header_json: a v2 record's routing header, kept in D1
--     so polls never read R2. NULL = a legacy v1 record (the full record
--     JSON stays in the payload store as text, as before). A v2 record's
--     payload-store object is the raw ciphertext blob; size_bytes is the
--     blob length either way, so the aggregate stats queries are unchanged.
--   * prototype_devices.payload_versions: JSON array of payload formats this
--     device can decrypt (e.g. '[1,2]'), advertised through the directory so
--     a sender never emits a format a recipient cannot read. NULL = legacy
--     device, understood as [1].
ALTER TABLE prototype_notes ADD COLUMN header_json TEXT;
ALTER TABLE prototype_devices ADD COLUMN payload_versions TEXT;
