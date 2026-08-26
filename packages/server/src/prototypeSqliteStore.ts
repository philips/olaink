import { createRequire } from 'node:module';
import type { DevicePublicKey, EncryptedNoteRecordV1 } from './prototypeNoteCrypto.ts';
import type { DeviceDirectory } from './prototypeNoteRelay.ts';
import type { UsernameClaimResult } from './accountUsernames.ts';

export interface UsernameAssignment {
  userId: string;
  username: string;
  status: 'active' | 'retired';
  assignedAt: number;
  retiredAt: number | null;
}

/**
 * Bun's binding serves the deployed binary; Node 22's built-in SQLite binding
 * lets the Vitest suite use the same SQLite-backed storage contract.
 */
type Statement = {
  get(...values: unknown[]): Record<string, unknown> | null;
  all(...values: unknown[]): Array<Record<string, unknown>>;
  run(...values: unknown[]): { changes?: number };
};
type SqliteDatabase = {
  exec(sql: string): void;
  query(sql: string): Statement;
  close(): void;
};

const require = createRequire(import.meta.url);

function openDatabase(path: string): SqliteDatabase {
  // The deployed binary uses Bun's binding. Node 22's built-in binding lets
  // Vitest exercise the exact SQLite-backed server rather than a Map-based
  // stand-in.
  try {
    const { Database } = require('bun:sqlite') as { Database: new (filename: string) => SqliteDatabase };
    return new Database(path);
  } catch {
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (filename: string) => {
        exec(sql: string): void;
        prepare(sql: string): {
          get(...values: unknown[]): Record<string, unknown> | undefined;
          all(...values: unknown[]): Array<Record<string, unknown>>;
          run(...values: unknown[]): { changes?: number };
        };
        close(): void;
      };
    };
    const db = new DatabaseSync(path);
    return {
      exec: (sql) => db.exec(sql),
      query: (sql) => {
        const statement = db.prepare(sql);
        return {
          get: (...values) => statement.get(...values) ?? null,
          all: (...values) => statement.all(...values),
          run: (...values) => statement.run(...values),
        };
      },
      close: () => db.close(),
    };
  }
}

export class PrototypeSqliteStore {
  private readonly db: SqliteDatabase;

  constructor(path: string) {
    if (!path) throw new Error('database path is required');
    this.db = openDatabase(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS prototype_directories (
        user_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 0)
      );
      CREATE TABLE IF NOT EXISTS prototype_devices (
        device_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES prototype_directories(user_id) ON DELETE CASCADE,
        public_key_spki TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prototype_devices_by_user ON prototype_devices(user_id, device_id);
      CREATE TABLE IF NOT EXISTS prototype_notes (
        id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prototype_note_deliveries (
        device_id TEXT NOT NULL REFERENCES prototype_devices(device_id) ON DELETE CASCADE,
        record_id TEXT NOT NULL REFERENCES prototype_notes(id) ON DELETE CASCADE,
        PRIMARY KEY (device_id, record_id)
      );
      CREATE INDEX IF NOT EXISTS prototype_note_deliveries_by_device ON prototype_note_deliveries(device_id, record_id);
      CREATE TABLE IF NOT EXISTS prototype_accounts (
        subject TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_usernames (
        canonical_username TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
        assigned_at INTEGER NOT NULL,
        retired_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS prototype_pairings (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES prototype_directories(user_id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prototype_pairings_expiry ON prototype_pairings(expires_at);
      -- A pairing-created capability is restricted to one already-enrolled
      -- companion device's poll/ack operations. Only its SHA-256 digest is
      -- durable; the raw bearer value exists only in the companion profile.
      CREATE TABLE IF NOT EXISTS prototype_device_sessions (
        token_hash TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES prototype_devices(device_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prototype_device_sessions_by_device ON prototype_device_sessions(device_id);
      CREATE TABLE IF NOT EXISTS prototype_server_state (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  registerDevice(userId: string, device: DevicePublicKey, now: number): DeviceDirectory {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.query('SELECT user_id, public_key_spki FROM prototype_devices WHERE device_id = ?')
        .get(device.deviceId);
      if (existing && existing['user_id'] !== userId) throw new Error('device ID is already registered');

      let directory = this.db.query('SELECT version FROM prototype_directories WHERE user_id = ?').get(userId);
      if (!directory) {
        this.db.query('INSERT INTO prototype_directories (user_id, version) VALUES (?, 0)').run(userId);
        directory = { version: 0 };
      }
      if (!existing) {
        this.db.query('INSERT INTO prototype_devices (device_id, user_id, public_key_spki, created_at) VALUES (?, ?, ?, ?)')
          .run(device.deviceId, userId, device.publicKeySpki, now);
        // The first device establishes directory version 1. Every later
        // enrollment or key rotation increments it once.
        this.db.query('UPDATE prototype_directories SET version = version + 1 WHERE user_id = ?').run(userId);
      } else if (existing['public_key_spki'] !== device.publicKeySpki) {
        this.db.query('UPDATE prototype_devices SET public_key_spki = ? WHERE device_id = ?')
          .run(device.publicKeySpki, device.deviceId);
        this.db.query('UPDATE prototype_directories SET version = version + 1 WHERE user_id = ?').run(userId);
      }
      this.db.exec('COMMIT');
      return this.directory(userId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Deletes the device and its scoped sessions/deliveries through foreign-key cascades. */
  unregisterDevice(deviceId: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const device = this.db.query('SELECT user_id FROM prototype_devices WHERE device_id = ?').get(deviceId);
      if (!device) {
        this.db.exec('COMMIT');
        return false;
      }
      const userId = device['user_id'] as string;
      this.db.query('DELETE FROM prototype_devices WHERE device_id = ?').run(deviceId);
      this.db.query('UPDATE prototype_directories SET version = version + 1 WHERE user_id = ?').run(userId);
      this.db.query('DELETE FROM prototype_notes WHERE NOT EXISTS (SELECT 1 FROM prototype_note_deliveries d WHERE d.record_id = prototype_notes.id)')
        .run();
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  directory(userId: string): DeviceDirectory {
    const directory = this.db.query('SELECT version FROM prototype_directories WHERE user_id = ?').get(userId);
    const devices = this.db.query('SELECT device_id, public_key_spki FROM prototype_devices WHERE user_id = ? ORDER BY device_id')
      .all(userId)
      .map((row) => ({ deviceId: row['device_id'] as string, publicKeySpki: row['public_key_spki'] as string }));
    return { userId, version: (directory?.['version'] as number | undefined) ?? 0, devices };
  }

  device(deviceId: string): { userId: string; deviceId: string; publicKeySpki: string } | null {
    const row = this.db.query('SELECT user_id, device_id, public_key_spki FROM prototype_devices WHERE device_id = ?').get(deviceId);
    return row ? {
      userId: row['user_id'] as string,
      deviceId: row['device_id'] as string,
      publicKeySpki: row['public_key_spki'] as string,
    } : null;
  }

  enqueue(record: EncryptedNoteRecordV1, now: number): void {
    const encoded = JSON.stringify(record);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.query('SELECT record_json FROM prototype_notes WHERE id = ?').get(record.id);
      if (existing && existing['record_json'] !== encoded) throw new Error('record ID is already in use');
      if (!existing) {
        this.db.query('INSERT INTO prototype_notes (id, record_json, created_at) VALUES (?, ?, ?)')
          .run(record.id, encoded, now);
      }
      const delivery = this.db.query('INSERT OR IGNORE INTO prototype_note_deliveries (device_id, record_id) VALUES (?, ?)');
      for (const slot of record.keySlots) delivery.run(slot.deviceId, record.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  poll(deviceId: string): EncryptedNoteRecordV1[] {
    return this.db.query(`
      SELECT n.record_json FROM prototype_note_deliveries d
      JOIN prototype_notes n ON n.id = d.record_id
      WHERE d.device_id = ? ORDER BY n.created_at, n.id
    `).all(deviceId).map((row) => JSON.parse(row['record_json'] as string) as EncryptedNoteRecordV1);
  }

  acknowledge(deviceId: string, recordIds: string[]): number {
    if (recordIds.length === 0) return 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.db.query('DELETE FROM prototype_note_deliveries WHERE device_id = ? AND record_id = ?');
      let acknowledged = 0;
      for (const recordId of new Set(recordIds)) acknowledged += remove.run(deviceId, recordId).changes ?? 0;
      this.db.query('DELETE FROM prototype_notes WHERE NOT EXISTS (SELECT 1 FROM prototype_note_deliveries d WHERE d.record_id = prototype_notes.id)')
        .run();
      this.db.exec('COMMIT');
      return acknowledged;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  userIdForSubject(subject: string): string | null {
    const row = this.db.query('SELECT user_id FROM prototype_accounts WHERE subject = ?').get(subject);
    return row ? row['user_id'] as string : null;
  }

  saveSubjectUser(subject: string, userId: string, now: number): string {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.userIdForSubject(subject);
      if (existing) {
        this.db.exec('COMMIT');
        return existing;
      }
      this.db.query('INSERT INTO prototype_accounts (subject, user_id, created_at) VALUES (?, ?, ?)')
        .run(subject, userId, now);
      this.db.exec('COMMIT');
      return userId;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  usernameForUser(userId: string): UsernameAssignment | null {
    const row = this.db.query(`SELECT user_id, canonical_username, status, assigned_at, retired_at
      FROM account_usernames WHERE user_id = ?`).get(userId);
    return row ? usernameAssignment(row) : null;
  }

  /** The only assignment write: names and account ownership are immutable. */
  claimUsername(userId: string, username: string, now: number): UsernameClaimResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owned = this.usernameForUser(userId);
      if (owned) {
        this.db.exec('COMMIT');
        return owned.username === username
          ? { outcome: 'assigned', assignment: owned, idempotent: true }
          : { outcome: 'already_assigned', assignment: owned };
      }
      const held = this.db.query('SELECT 1 FROM account_usernames WHERE canonical_username = ?').get(username);
      if (held) {
        this.db.exec('COMMIT');
        return { outcome: 'unavailable' };
      }
      this.db.query(`INSERT INTO account_usernames
        (canonical_username, user_id, status, assigned_at, retired_at) VALUES (?, ?, 'active', ?, NULL)`)
        .run(username, userId, now);
      const assignment: UsernameAssignment = { userId, username, status: 'active', assignedAt: now, retiredAt: null };
      this.db.exec('COMMIT');
      return { outcome: 'assigned', assignment, idempotent: false };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  resolveActiveUsername(username: string): UsernameAssignment | null {
    const row = this.db.query(`SELECT user_id, canonical_username, status, assigned_at, retired_at
      FROM account_usernames WHERE canonical_username = ? AND status = 'active'`).get(username);
    return row ? usernameAssignment(row) : null;
  }

  /** Account closure retains an irreversible routing tombstone. */
  retireUsername(userId: string, now: number): boolean {
    return (this.db.query(`UPDATE account_usernames SET status = 'retired', retired_at = ?
      WHERE user_id = ? AND status = 'active'`).run(now, userId).changes ?? 0) === 1;
  }

  pairingExists(code: string): boolean {
    return this.db.query('SELECT 1 FROM prototype_pairings WHERE code = ?').get(code) !== null;
  }

  savePairing(code: string, userId: string, expiresAt: number): void {
    this.db.query('INSERT INTO prototype_pairings (code, user_id, expires_at) VALUES (?, ?, ?)')
      .run(code, userId, expiresAt);
  }

  takePairing(code: string, now: number): string | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.query('SELECT user_id, expires_at FROM prototype_pairings WHERE code = ?').get(code);
      this.db.query('DELETE FROM prototype_pairings WHERE code = ?').run(code);
      this.db.exec('COMMIT');
      return row && (row['expires_at'] as number) > now ? row['user_id'] as string : null;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  prunePairings(now: number): void {
    this.db.query('DELETE FROM prototype_pairings WHERE expires_at <= ?').run(now);
  }

  saveDeviceSession(tokenHash: string, deviceId: string, now: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Re-pairing replaces any previous capability for this device.
      this.db.query('DELETE FROM prototype_device_sessions WHERE device_id = ?').run(deviceId);
      this.db.query('INSERT INTO prototype_device_sessions (token_hash, device_id, created_at) VALUES (?, ?, ?)')
        .run(tokenHash, deviceId, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deviceForSession(tokenHash: string): string | null {
    const row = this.db.query('SELECT device_id FROM prototype_device_sessions WHERE token_hash = ?').get(tokenHash);
    return row ? row['device_id'] as string : null;
  }

  deleteDeviceSession(tokenHash: string): boolean {
    return (this.db.query('DELETE FROM prototype_device_sessions WHERE token_hash = ?').run(tokenHash).changes ?? 0) === 1;
  }

  getServerState(name: string): string | null {
    const row = this.db.query('SELECT value FROM prototype_server_state WHERE name = ?').get(name);
    return row ? row['value'] as string : null;
  }

  setServerState(name: string, value: string): void {
    this.db.query(`INSERT INTO prototype_server_state (name, value) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value`).run(name, value);
  }

  deleteServerState(name: string): void {
    this.db.query('DELETE FROM prototype_server_state WHERE name = ?').run(name);
  }
}

function usernameAssignment(row: Record<string, unknown>): UsernameAssignment {
  return {
    userId: row['user_id'] as string,
    username: row['canonical_username'] as string,
    status: row['status'] as 'active' | 'retired',
    assignedAt: row['assigned_at'] as number,
    retiredAt: row['retired_at'] === null ? null : row['retired_at'] as number,
  };
}
