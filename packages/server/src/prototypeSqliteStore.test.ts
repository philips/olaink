import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encryptNoteForDevices, generateDeviceKeyPair } from './prototypeNoteCrypto.ts';
import { PrototypeNoteRelay } from './prototypeNoteRelay.ts';
import { PrototypePairingService } from './prototypePairing.ts';
import { PrototypeSqliteStore } from './prototypeSqliteStore.ts';

describe('Bun SQLite prototype store', () => {
  it('retains encrypted deliveries across a relay restart', async () => {
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

  it('retains pairing codes, account mappings, and device sessions across restarts', async () => {
    const databasePath = join(tmpdir(), `olaink-pairing-${randomUUID()}.sqlite`);
    const primary = generateDeviceKeyPair('sqlite-primary');
    const companion = generateDeviceKeyPair('sqlite-companion');
    try {
      const firstStore = new PrototypeSqliteStore(databasePath);
      const firstPairing = new PrototypePairingService(new PrototypeNoteRelay({ store: firstStore }), { store: firstStore });
      const started = firstPairing.start('authgravity-subject', primary);
      firstStore.close();

      const secondStore = new PrototypeSqliteStore(databasePath);
      const secondPairing = new PrototypePairingService(new PrototypeNoteRelay({ store: secondStore }), { store: secondStore });
      expect(secondPairing.accountForSubject('authgravity-subject')).toBe(started.userId);
      const claimed = secondPairing.claim(started.code, companion);
      expect(claimed.userId).toBe(started.userId);
      expect(claimed.directory.devices.map((device) => device.deviceId).sort())
        .toEqual([primary.deviceId, companion.deviceId].sort());
      secondStore.close();

      const thirdStore = new PrototypeSqliteStore(databasePath);
      const thirdPairing = new PrototypePairingService(new PrototypeNoteRelay({ store: thirdStore }), { store: thirdStore });
      expect(thirdPairing.deviceForSession(claimed.deviceSessionToken)).toBe(companion.deviceId);
      expect(() => thirdPairing.claim(started.code, generateDeviceKeyPair('sqlite-other'))).toThrow('invalid or expired pairing code');
      thirdStore.close();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('retains active assignments and retired username tombstones across restarts', async () => {
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
