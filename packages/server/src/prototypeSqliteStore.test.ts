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
    const echo = generateDeviceKeyPair('echo-prototype-device');
    const alice = generateDeviceKeyPair('sqlite-alice');
    const bob = generateDeviceKeyPair('sqlite-bob');
    try {
      const firstStore = new PrototypeSqliteStore(databasePath);
      const first = new PrototypeNoteRelay({ store: firstStore, echo });
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
      const second = new PrototypeNoteRelay({ store: secondStore, echo });
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
});
