/**
 * D1 backend for relay state. Same schema and semantics as the retired
 * PrototypeSqliteStore, with two structural differences:
 *
 *   * Note payloads live in R2 (NotePayloadStore), not in the notes table;
 *     the store handles metadata and delivery rows only.
 *   * D1 has no explicit BEGIN/COMMIT. Each logical transaction is one
 *     db.batch() (a single D1 transaction), and read-then-write sequences
 *     use the write's own result (changes count / ON CONFLICT DO NOTHING)
 *     as the race arbiter, mirroring the SQLite store's IMMEDIATE-lock
 *     behavior closely enough that observable differences only occur on
 *     same-millisecond races of duplicate client operations.
 *
 * The structural D1DatabaseLike below is satisfied both by the real D1
 * binding (wrangler/Workers) and by the standalone binary's bun:sqlite shim,
 * so the same store code runs in both.
 */
import type { DevicePublicKey, EncryptedNoteRecordV1 } from './prototypeNoteCrypto.ts';
import type { DeviceDirectory } from './prototypeNoteRelay.ts';
import type { UsernameAssignment, UsernameClaimResult } from './accountUsernames.ts';

/** Structural slice of D1's result object (run/all/batch share it). */
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes: number; last_row_id: number };
}

export interface D1PreparedStatement {
  bind(...params: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement;
  /** Runs all statements atomically in a single transaction. */
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export class D1Store {
  private constructor(private readonly db: D1DatabaseLike) {}

  static open(db: D1DatabaseLike): D1Store {
    return new D1Store(db);
  }

  async registerDevice(userId: string, device: DevicePublicKey, now: number): Promise<DeviceDirectory> {
    const existing = await this.db
      .prepare('SELECT user_id, public_key_spki FROM prototype_devices WHERE device_id = ?')
      .bind(device.deviceId)
      .first();
    if (existing && existing['user_id'] !== userId) throw new Error('device ID is already registered');

    let changed = false;
    if (!existing) {
      const results = await this.db.batch([
        this.db.prepare('INSERT INTO prototype_directories (user_id, version) VALUES (?, 0) ON CONFLICT (user_id) DO NOTHING')
          .bind(userId),
        // ON CONFLICT keeps a concurrent first enrollment idempotent instead
        // of throwing; the loser re-reads the winner's row below.
        this.db.prepare('INSERT INTO prototype_devices (device_id, user_id, public_key_spki, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (device_id) DO NOTHING')
          .bind(device.deviceId, userId, device.publicKeySpki, now),
      ]);
      if ((results[1]?.meta.changes ?? 0) === 1) {
        changed = true;
      } else {
        const winner = await this.db
          .prepare('SELECT user_id FROM prototype_devices WHERE device_id = ?')
          .bind(device.deviceId)
          .first();
        if (winner && winner['user_id'] !== userId) throw new Error('device ID is already registered');
      }
    } else if (existing['public_key_spki'] !== device.publicKeySpki) {
      const updated = await this.db
        .prepare('UPDATE prototype_devices SET public_key_spki = ? WHERE device_id = ? AND user_id = ?')
        .bind(device.publicKeySpki, device.deviceId, userId)
        .run();
      changed = updated.meta.changes === 1;
    }
    if (changed) {
      // The first device establishes directory version 1; every later
      // enrollment or key rotation increments it once.
      await this.db.prepare('UPDATE prototype_directories SET version = version + 1 WHERE user_id = ?').bind(userId).run();
    }
    return this.directory(userId);
  }

  /**
   * Deletes the device and its scoped sessions/deliveries through foreign-key
   * cascades. Returns the note record IDs that lost their last delivery, so
   * the caller can garbage-collect the matching R2 payloads.
   */
  async unregisterDevice(deviceId: string): Promise<{ removed: boolean; gcRecordIds: string[] }> {
    const device = await this.db.prepare('SELECT user_id FROM prototype_devices WHERE device_id = ?')
      .bind(deviceId)
      .first();
    if (!device) return { removed: false, gcRecordIds: [] };
    const userId = device['user_id'] as string;
    const candidates = await this.db.prepare(
      'SELECT record_id FROM prototype_note_deliveries WHERE device_id = ?',
    ).bind(deviceId).all();
    const results = await this.db.batch([
      this.db.prepare('DELETE FROM prototype_devices WHERE device_id = ?').bind(deviceId),
      this.db.prepare('UPDATE prototype_directories SET version = version + 1 WHERE user_id = ?').bind(userId),
      ...candidates.results.map((row) => this.deleteNoteIfUndelivered(row['record_id'] as string)),
    ]);
    const gcRecordIds = candidates.results
      .filter((_, index) => results[index + 2]?.meta.changes === 1)
      .map((row) => row['record_id'] as string);
    return { removed: true, gcRecordIds };
  }

  async directory(userId: string): Promise<DeviceDirectory> {
    const directory = await this.db.prepare('SELECT version FROM prototype_directories WHERE user_id = ?')
      .bind(userId)
      .first();
    const rows = await this.db.prepare(
      'SELECT device_id, public_key_spki FROM prototype_devices WHERE user_id = ? ORDER BY device_id',
    ).bind(userId).all();
    return {
      userId,
      version: (directory?.['version'] as number | undefined) ?? 0,
      devices: rows.results.map((row) => ({
        deviceId: row['device_id'] as string,
        publicKeySpki: row['public_key_spki'] as string,
      })),
    };
  }

  async device(deviceId: string): Promise<{ userId: string; deviceId: string; publicKeySpki: string } | null> {
    const row = await this.db.prepare(
      'SELECT user_id, device_id, public_key_spki FROM prototype_devices WHERE device_id = ?',
    ).bind(deviceId).first();
    if (!row) return null;
    return {
      userId: row['user_id'] as string,
      deviceId: row['device_id'] as string,
      publicKeySpki: row['public_key_spki'] as string,
    };
  }

  /**
   * Queues record metadata and delivery rows. The caller (relay) stores the
   * payload in R2 first and has verified the stored payload, if any, matches
   * this record. Idempotent on re-send, matching the SQLite store: an
   * existing note row does not fail and delivery rows are re-added.
   */
  async enqueue(record: EncryptedNoteRecordV1, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare('INSERT INTO prototype_notes (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING')
        .bind(record.id, now),
      ...record.keySlots.map((slot) =>
        this.db.prepare('INSERT OR IGNORE INTO prototype_note_deliveries (device_id, record_id) VALUES (?, ?)')
          .bind(slot.deviceId, record.id)),
    ]);
  }

  /** Pending deliveries as record references; payloads are fetched from R2. */
  async poll(deviceId: string): Promise<{ recordId: string; createdAt: number }[]> {
    const rows = await this.db.prepare(`
      SELECT d.record_id AS recordId, n.created_at AS createdAt
      FROM prototype_note_deliveries AS d
      JOIN prototype_notes AS n ON n.id = d.record_id
      WHERE d.device_id = ? ORDER BY n.created_at, n.id
    `).bind(deviceId).all();
    return rows.results.map((row) => ({
      recordId: row['recordId'] as string,
      createdAt: row['createdAt'] as number,
    }));
  }

  /**
   * Removes this device's deliveries for the given records and deletes the
   * metadata rows of records that lost their last delivery. Returns the
   * acknowledged count plus the GC'd record IDs (R2 payloads are deleted by
   * the caller, best-effort).
   */
  async acknowledge(
    deviceId: string,
    recordIds: string[],
  ): Promise<{ acknowledged: number; gcRecordIds: string[] }> {
    if (recordIds.length === 0) return { acknowledged: 0, gcRecordIds: [] };
    const unique = [...new Set(recordIds)];
    const results = await this.db.batch(unique.map((recordId) =>
      this.db.prepare('DELETE FROM prototype_note_deliveries WHERE device_id = ? AND record_id = ?')
        .bind(deviceId, recordId)));
    const acknowledged = results.reduce((total, result) => total + result.meta.changes, 0);
    if (acknowledged === 0) return { acknowledged: 0, gcRecordIds: [] };
    // Only records this device actually held are GC candidates.
    const removed = unique.filter((_, index) => results[index]?.meta.changes === 1);
    const gcResults = await this.db.batch(removed.map((recordId) => this.deleteNoteIfUndelivered(recordId)));
    const gcRecordIds = removed.filter((_, index) => gcResults[index]?.meta.changes === 1);
    return { acknowledged, gcRecordIds };
  }

  async userIdForSubject(subject: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT user_id FROM prototype_accounts WHERE subject = ?')
      .bind(subject)
      .first();
    return row ? (row['user_id'] as string) : null;
  }

  async saveSubjectUser(subject: string, userId: string, now: number): Promise<string> {
    const existing = await this.userIdForSubject(subject);
    if (existing) return existing;
    try {
      await this.db.prepare('INSERT INTO prototype_accounts (subject, user_id, created_at) VALUES (?, ?, ?)')
        .bind(subject, userId, now)
        .run();
      return userId;
    } catch (error) {
      if (!D1Store.isUniqueViolation(error)) throw error;
      const raced = await this.userIdForSubject(subject);
      if (raced) return raced;
      throw error;
    }
  }

  async usernameForUser(userId: string): Promise<UsernameAssignment | null> {
    const row = await this.db.prepare(`SELECT user_id, canonical_username, status, assigned_at, retired_at
      FROM account_usernames WHERE user_id = ?`).bind(userId).first();
    return row ? usernameAssignment(row) : null;
  }

  /** The only assignment write: names and account ownership are immutable. */
  async claimUsername(userId: string, username: string, now: number): Promise<UsernameClaimResult> {
    const owned = await this.usernameForUser(userId);
    if (owned) {
      return owned.username === username
        ? { outcome: 'assigned', assignment: owned, idempotent: true }
        : { outcome: 'already_assigned', assignment: owned };
    }
    const held = await this.db.prepare('SELECT 1 FROM account_usernames WHERE canonical_username = ?')
      .bind(username)
      .first();
    if (held) return { outcome: 'unavailable' };
    try {
      await this.db.prepare(`INSERT INTO account_usernames
        (canonical_username, user_id, status, assigned_at, retired_at) VALUES (?, ?, 'active', ?, NULL)`)
        .bind(username, userId, now)
        .run();
      const assignment: UsernameAssignment = { userId, username, status: 'active', assignedAt: now, retiredAt: null };
      return { outcome: 'assigned', assignment, idempotent: false };
    } catch (error) {
      // A concurrent claim of the same name (active or retired tombstone)
      // must be indistinguishable from an existing claim.
      if (D1Store.isUniqueViolation(error)) return { outcome: 'unavailable' };
      throw error;
    }
  }

  async resolveActiveUsername(username: string): Promise<UsernameAssignment | null> {
    const row = await this.db.prepare(`SELECT user_id, canonical_username, status, assigned_at, retired_at
      FROM account_usernames WHERE canonical_username = ? AND status = 'active'`).bind(username).first();
    return row ? usernameAssignment(row) : null;
  }

  /** Account closure retains an irreversible routing tombstone. */
  async retireUsername(userId: string, now: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE account_usernames SET status = 'retired', retired_at = ?
      WHERE user_id = ? AND status = 'active'`).bind(now, userId).run();
    return result.meta.changes === 1;
  }

  async pairingExists(code: string): Promise<boolean> {
    return (await this.db.prepare('SELECT 1 FROM prototype_pairings WHERE code = ?').bind(code).first()) !== null;
  }

  async savePairing(code: string, userId: string, expiresAt: number): Promise<void> {
    await this.db.prepare('INSERT INTO prototype_pairings (code, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(code, userId, expiresAt)
      .run();
  }

  async takePairing(code: string, now: number): Promise<string | null> {
    const row = await this.db.prepare('SELECT user_id, expires_at FROM prototype_pairings WHERE code = ?')
      .bind(code)
      .first();
    if (!row) return null;
    // A single DELETE arbitrates concurrent claims: D1 serializes writes, so
    // exactly one caller observes changes = 1.
    const removed = await this.db.prepare('DELETE FROM prototype_pairings WHERE code = ?').bind(code).run();
    return removed.meta.changes === 1 && (row['expires_at'] as number) > now ? (row['user_id'] as string) : null;
  }

  async prunePairings(now: number): Promise<void> {
    await this.db.prepare('DELETE FROM prototype_pairings WHERE expires_at <= ?').bind(now).run();
  }

  async saveDeviceSession(tokenHash: string, deviceId: string, now: number): Promise<void> {
    // Re-pairing replaces any previous capability for this device.
    await this.db.batch([
      this.db.prepare('DELETE FROM prototype_device_sessions WHERE device_id = ?').bind(deviceId),
      this.db.prepare('INSERT INTO prototype_device_sessions (token_hash, device_id, created_at) VALUES (?, ?, ?)')
        .bind(tokenHash, deviceId, now),
    ]);
  }

  async deviceForSession(tokenHash: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT device_id FROM prototype_device_sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .first();
    return row ? (row['device_id'] as string) : null;
  }

  async deleteDeviceSession(tokenHash: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM prototype_device_sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * Deletes a note's metadata only while no delivery row references it, so a
   * concurrent idempotent re-send that re-added deliveries keeps its note.
   * changes = 1 tells the caller to garbage-collect the payload.
   */
  private deleteNoteIfUndelivered(recordId: string): D1PreparedStatement {
    return this.db.prepare(`DELETE FROM prototype_notes WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM prototype_note_deliveries WHERE record_id = ?)`).bind(recordId, recordId);
  }

  private static isUniqueViolation(error: unknown): boolean {
    return error instanceof Error && error.message.includes('UNIQUE constraint failed');
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
