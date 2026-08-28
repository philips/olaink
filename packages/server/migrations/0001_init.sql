-- Ola Ink D1 schema.
--
-- Table and column names intentionally match the pre-migration SQLite schema
-- so the Phase 3 data migration is a straight row copy. Two deliberate
-- differences:
--   * prototype_notes no longer stores record_json (the payload moved to R2,
--     one object per note record ID);
--   * prototype_server_state was retired (its only consumer was a one-time
--     echo-key cleanup, already run on the production database);
--   * pairing_claim_buckets is new: free-plan rate limiting for
--     POST /v1/pairings/claim (one 60s counter bucket per client key).

CREATE TABLE prototype_directories (
  user_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 0)
);

CREATE TABLE prototype_devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES prototype_directories(user_id) ON DELETE CASCADE,
  public_key_spki TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX prototype_devices_by_user ON prototype_devices(user_id, device_id);

CREATE TABLE prototype_notes (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE prototype_note_deliveries (
  device_id TEXT NOT NULL REFERENCES prototype_devices(device_id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES prototype_notes(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, record_id)
);
CREATE INDEX prototype_note_deliveries_by_device ON prototype_note_deliveries(device_id, record_id);

CREATE TABLE prototype_accounts (
  subject TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- The no-username-reuse promise rests on canonical_username staying UNIQUE
-- across active assignments and retired tombstones. Never enable
-- multi-region D1 without redesigning this table.
CREATE TABLE account_usernames (
  canonical_username TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  assigned_at INTEGER NOT NULL,
  retired_at INTEGER
);

CREATE TABLE prototype_pairings (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES prototype_directories(user_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX prototype_pairings_expiry ON prototype_pairings(expires_at);

-- A pairing-created capability is restricted to one already-enrolled
-- companion device's poll/ack operations. Only its SHA-256 digest is
-- durable; the raw bearer value exists only in the companion profile.
CREATE TABLE prototype_device_sessions (
  token_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES prototype_devices(device_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX prototype_device_sessions_by_device ON prototype_device_sessions(device_id);

CREATE TABLE pairing_claim_buckets (
  client_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (client_key, window_start)
);
