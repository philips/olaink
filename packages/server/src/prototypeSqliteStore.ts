import { createRequire } from 'node:module';
import type { DevicePublicKey, EncryptedNoteRecordV1 } from './prototypeNoteCrypto.ts';
import type { DeviceDirectory } from './prototypeNoteRelay.ts';

/**
 * Bun's built-in SQLite binding is loaded lazily so the Node/vitest suite can
 * still exercise the in-memory prototype implementation. The deployable Bun
 * binary always constructs this store.
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
  let Database: new (filename: string) => SqliteDatabase;
  try {
    ({ Database } = require('bun:sqlite') as { Database: new (filename: string) => SqliteDatabase });
  } catch {
    throw new Error('SQLite persistence requires the Bun runtime');
  }
  return new Database(path);
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
      CREATE TABLE IF NOT EXISTS prototype_pairings (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES prototype_directories(user_id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prototype_pairings_expiry ON prototype_pairings(expires_at);
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
    this.db.query('INSERT OR IGNORE INTO prototype_accounts (subject, user_id, created_at) VALUES (?, ?, ?)')
      .run(subject, userId, now);
    return this.userIdForSubject(subject) ?? userId;
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

  getServerState(name: string): string | null {
    const row = this.db.query('SELECT value FROM prototype_server_state WHERE name = ?').get(name);
    return row ? row['value'] as string : null;
  }

  setServerState(name: string, value: string): void {
    this.db.query(`INSERT INTO prototype_server_state (name, value) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value`).run(name, value);
  }
}
