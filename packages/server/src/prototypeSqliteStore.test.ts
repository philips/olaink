import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encryptNoteForDevices, generateDeviceKeyPair } from './prototypeNoteCrypto.ts';
import { PrototypeNoteRelay } from './prototypeNoteRelay.ts';
import { PrototypeSqliteStore } from './prototypeSqliteStore.ts';

const bunIt = (globalThis as typeof globalThis & { Bun?: unknown }).Bun ? it : it.skip;

describe('Bun SQLite prototype store', () => {
  bunIt('retains encrypted deliveries across a relay restart', async () => {
    const databasePath = join(tmpdir(), `olaink-${randomUUID()}.sqlite`);
    const alice = generateDeviceKeyPair('sqlite-alice');
    const bob = generateDeviceKeyPair('sqlite-bob');
    try {
      const firstStore = new PrototypeSqliteStore(databasePath);
      const first = new PrototypeNoteRelay({ store: firstStore });
      first.registerDevice('alice', alice);
      const directory = first.registerDevice('bob', bob);
      const record = encryptNoteForDevices(
        { filename: 'opaque.note', mime: 'application/x-supernote', note: Buffer.from('ciphertext fixture') },
        {
          fromUserId: 'alice', fromDeviceId: alice.deviceId, toUserId: 'bob',
          toDirectoryVersion: directory.version, recipients: directory.devices,
        },
      );
      await first.send(record);
      firstStore.close();

      const secondStore = new PrototypeSqliteStore(databasePath);
      const second = new PrototypeNoteRelay({ store: secondStore });
      expect(second.poll(bob.deviceId)).toEqual([record]);
      expect(second.acknowledge(bob.deviceId, [record.id])).toBe(1);
      expect(second.poll(bob.deviceId)).toEqual([]);
      secondStore.close();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  bunIt('retains active assignments and retired username tombstones across restarts', async () => {
    const databasePath = join(tmpdir(), `olaink-usernames-${randomUUID()}.sqlite`);
    try {
      const first = new PrototypeSqliteStore(databasePath);
      const mira = first.saveSubjectUser('authgravity-mira', 'account_mira', 10);
      const other = first.saveSubjectUser('authgravity-other', 'account_other', 10);
      expect(first.claimUsername(mira, 'mira', 11)).toMatchObject({ outcome: 'assigned', idempotent: false });
      expect(first.claimUsername(other, 'other', 12)).toMatchObject({ outcome: 'assigned', idempotent: false });
      expect(first.retireUsername(mira, 13)).toBe(true);
      first.close();

      const restored = new PrototypeSqliteStore(databasePath);
      expect(restored.usernameForUser(other)).toMatchObject({ username: 'other', status: 'active' });
      expect(restored.resolveActiveUsername('mira')).toBeNull();
      expect(restored.claimUsername('account_new', 'mira', 14)).toEqual({ outcome: 'unavailable' });
      restored.close();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });
});
