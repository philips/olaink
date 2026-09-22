import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { D1Store } from './d1Store.ts';
import { DirectoryNotePayloads } from './localNotePayloads.ts';
import { encryptNoteForDevices, generateDeviceKeyPair } from './prototypeNoteCrypto.ts';
import { PrototypeNoteRelay } from './prototypeNoteRelay.ts';
import { PrototypePairingService } from './prototypePairing.ts';
import { SqliteD1 } from './sqliteD1.ts';

async function withDataDir(run: (databasePath: string, notesPath: string) => Promise<void>): Promise<void> {
  const base = join(tmpdir(), `olaink-${randomUUID()}`);
  try {
    await run(`${base}.sqlite`, `${base}-notes`);
  } finally {
    for (const suffix of ['.sqlite', '.sqlite-wal', '.sqlite-shm']) await rm(`${base}${suffix}`, { force: true });
    await rm(`${base}-notes`, { recursive: true, force: true });
  }
}

function openRelay(databasePath: string, notesPath: string) {
  const db = SqliteD1.open(databasePath);
  const store = D1Store.open(db);
  const relay = new PrototypeNoteRelay({ store, payloads: new DirectoryNotePayloads(notesPath) });
  return { db, store, relay, pairing: new PrototypePairingService(relay, { store }) };
}

describe('SQLite D1 shim', () => {
  it('matches the D1 result shapes the store relies on', async () => {
    const db = SqliteD1.open(':memory:');
    try {
      expect(await db.prepare('SELECT user_id FROM prototype_accounts WHERE subject = ?').bind('none').first())
        .toBeNull();
      const inserted = await db.prepare('INSERT INTO prototype_accounts (subject, user_id, created_at) VALUES (?, ?, ?)')
        .bind('subject', 'account_one', 1).run();
      expect(inserted.meta.changes).toBe(1);
      expect(await db.prepare('SELECT user_id FROM prototype_accounts WHERE subject = ?').bind('subject')
        .first('user_id')).toBe('account_one');
      const [ignored, read] = await db.batch([
        db.prepare('INSERT OR IGNORE INTO prototype_accounts (subject, user_id, created_at) VALUES (?, ?, ?)')
          .bind('subject', 'account_one', 2),
        db.prepare('SELECT COUNT(*) AS count FROM prototype_accounts'),
      ]);
      expect(ignored!.meta.changes).toBe(0);
      expect(read!.results).toEqual([{ count: 1 }]);
      expect(() => db.prepare('SELECT ?').bind(undefined)).toThrow('D1_TYPE_ERROR');
    } finally {
      db.close();
    }
  });

  it('rolls back a whole batch when any statement fails, and enforces foreign keys', async () => {
    const db = SqliteD1.open(':memory:');
    try {
      await expect(db.batch([
        db.prepare('INSERT INTO prototype_accounts (subject, user_id, created_at) VALUES (?, ?, ?)').bind('a', 'account_a', 1),
        db.prepare('INSERT INTO prototype_accounts (subject, user_id, created_at) VALUES (?, ?, ?)').bind('b', 'account_a', 1),
      ])).rejects.toThrow('UNIQUE constraint failed');
      expect(await db.prepare('SELECT COUNT(*) AS count FROM prototype_accounts').first('count')).toBe(0);
      await expect(db.prepare('INSERT INTO prototype_devices (device_id, user_id, public_key_spki, created_at) VALUES (?, ?, ?, ?)')
        .bind('device', 'no-directory', 'key', 1).run()).rejects.toThrow('FOREIGN KEY constraint failed');
    } finally {
      db.close();
    }
  });

  it('applies each migration exactly once across restarts', async () => {
    await withDataDir(async (databasePath) => {
      SqliteD1.open(databasePath).close();
      const reopened = SqliteD1.open(databasePath);
      expect((await reopened.prepare('SELECT name FROM d1_migrations').all()).results).toEqual([{ name: '0001_init.sql' }]);
      reopened.close();
    });
  });
});

describe('standalone relay persistence', () => {
  it('retains encrypted deliveries and payloads across a relay restart', async () => {
    await withDataDir(async (databasePath, notesPath) => {
      const alice = await generateDeviceKeyPair('sqlite-alice');
      const bob = await generateDeviceKeyPair('sqlite-bob');
      const first = openRelay(databasePath, notesPath);
      await first.relay.registerDevice('alice', alice);
      const directory = await first.relay.registerDevice('bob', bob);
      const record = await encryptNoteForDevices(
        { filename: 'opaque.note', mime: 'application/x-supernote', note: new TextEncoder().encode('ciphertext fixture') },
        {
          fromUserId: 'alice', fromDeviceId: alice.deviceId, toUserId: 'bob',
          toDirectoryVersion: directory.version, recipients: directory.devices,
        },
      );
      await first.relay.send(record);
      first.db.close();

      const second = openRelay(databasePath, notesPath);
      expect(await second.relay.poll(bob.deviceId)).toEqual([record]);
      expect(await second.relay.acknowledge(bob.deviceId, [record.id])).toBe(1);
      expect(await second.relay.poll(bob.deviceId)).toEqual([]);
      expect(await new DirectoryNotePayloads(notesPath).get(record.id)).toBeNull();
      second.db.close();
    });
  });

  it('retains pairing codes, account mappings, and device sessions across restarts', async () => {
    await withDataDir(async (databasePath, notesPath) => {
      const primary = await generateDeviceKeyPair('sqlite-primary');
      const companion = await generateDeviceKeyPair('sqlite-companion');
      const first = openRelay(databasePath, notesPath);
      const started = await first.pairing.start('authgravity-subject', primary);
      first.db.close();

      const second = openRelay(databasePath, notesPath);
      expect(await second.pairing.accountForSubject('authgravity-subject')).toBe(started.userId);
      const claimed = await second.pairing.claim(started.code, companion);
      expect(claimed.userId).toBe(started.userId);
      expect(claimed.directory.devices.map((device) => device.deviceId).sort())
        .toEqual([primary.deviceId, companion.deviceId].sort());
      second.db.close();

      const third = openRelay(databasePath, notesPath);
      expect(await third.pairing.deviceForSession(claimed.deviceSessionToken)).toBe(companion.deviceId);
      const other = await generateDeviceKeyPair('sqlite-other');
      await expect(third.pairing.claim(started.code, other)).rejects.toThrow('invalid or expired pairing code');
      third.db.close();
    });
  });

  it('retains active assignments and retired username tombstones across restarts', async () => {
    await withDataDir(async (databasePath) => {
      const firstDb = SqliteD1.open(databasePath);
      const first = D1Store.open(firstDb);
      const mira = await first.saveSubjectUser('authgravity-mira', 'account_mira', 10);
      const other = await first.saveSubjectUser('authgravity-other', 'account_other', 10);
      expect(await first.claimUsername(mira, 'mira', 11)).toMatchObject({ outcome: 'assigned', idempotent: false });
      expect(await first.claimUsername(other, 'other', 12)).toMatchObject({ outcome: 'assigned', idempotent: false });
      expect(await first.retireUsername(mira, 13)).toBe(true);
      firstDb.close();

      const restoredDb = SqliteD1.open(databasePath);
      const restored = D1Store.open(restoredDb);
      expect(await restored.usernameForUser(other)).toMatchObject({ username: 'other', status: 'active' });
      expect(await restored.resolveActiveUsername('mira')).toBeNull();
      expect(await restored.claimUsername('account_new', 'mira', 14)).toEqual({ outcome: 'unavailable' });
      restoredDb.close();
    });
  });
});
