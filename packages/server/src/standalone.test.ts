import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1Store } from './d1Store.ts';
import { DirectoryNotePayloads } from './localNotePayloads.ts';
import { encryptNoteForDevices, generateDeviceKeyPair } from './prototypeNoteCrypto.ts';
import { PrototypeNoteRelay } from './prototypeNoteRelay.ts';
import { SqliteD1 } from './sqliteD1.ts';
import { runRetentionSweepOnce, startStandalone, type StandaloneServer } from './standalone.ts';

// Bun.serve exists only under Bun: `npm run test:bun -w @olaink/server`.
const underBun = 'Bun' in globalThis;

describe.skipIf(!underBun)('standalone Bun.serve entry', () => {
  let server: StandaloneServer;
  let baseUrl: string;

  beforeAll(() => {
    server = startStandalone({
      host: '127.0.0.1',
      port: 0,
      databasePath: ':memory:',
      commit: 'b'.repeat(40),
      authGravity: { verify: async ({ authorization }) => authorization === 'Bearer owner' ? { subject: 'owner' } : null },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => server.stop());

  it('refuses to start without a SQLite database path', () => {
    expect(() => startStandalone({ databasePath: '', commit: 'unknown' })).toThrow('databasePath is required');
  });

  it('serves the shared handler over real sockets', async () => {
    expect(await (await fetch(`${baseUrl}/healthz`)).text()).toBe('ok');
    expect(await (await fetch(`${baseUrl}/commit`)).text()).toBe(`${'b'.repeat(40)}\n`);

    const preflight = await fetch(`${baseUrl}/v1/companion/poll`, {
      method: 'OPTIONS', headers: { Origin: 'https://appassets.androidplatform.net' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://appassets.androidplatform.net');

    const account = await fetch(`${baseUrl}/v1/account`, { headers: { Authorization: 'Bearer owner' } });
    expect(account.status).toBe(200);
    expect((await account.json() as { account: { userId: string } }).account.userId).toMatch(/^account_/);
  });

  it('caps request bodies at 10 MiB with the handler\'s 400', async () => {
    // Its own connection: the server answers before reading the rest of the
    // upload, and Bun's fetch client (inside vitest workers) can stall the
    // next request it pipelines onto that socket.
    const response = await fetch(`${baseUrl}/v1/notes`, {
      method: 'POST', keepalive: false, headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(10 * 1024 * 1024 + 1),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'bad_request' });
  });

  it('keys the pairing-claim rate limit on the socket address', async () => {
    const claim = () => fetch(`${baseUrl}/v1/pairings/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '00000000', device: {} }),
    });
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await claim()).status).toBe(400);
    expect((await claim()).status).toBe(429);
  });

  it('persists to the database and payload directory it was given', async () => {
    const base = join(tmpdir(), `olaink-standalone-${randomUUID()}`);
    try {
      const first = startStandalone({ host: '127.0.0.1', port: 0, databasePath: `${base}.sqlite`, commit: 'unknown',
        authGravity: { verify: async () => ({ subject: 'persisted' }) } });
      const created = await (await fetch(`http://127.0.0.1:${first.port}/v1/account`)).json() as { account: { userId: string } };
      await first.stop();
      const second = startStandalone({ host: '127.0.0.1', port: 0, databasePath: `${base}.sqlite`, commit: 'unknown',
        authGravity: { verify: async () => ({ subject: 'persisted' }) } });
      const reread = await (await fetch(`http://127.0.0.1:${second.port}/v1/account`)).json() as { account: { userId: string } };
      await second.stop();
      expect(reread.account.userId).toBe(created.account.userId);
    } finally {
      for (const suffix of ['.sqlite', '.sqlite-wal', '.sqlite-shm']) await rm(`${base}${suffix}`, { force: true });
      await rm(`${base}.sqlite-notes`, { recursive: true, force: true });
    }
  });
});

// Backs `olaink-server --retention-sweep-once`; needs only the shim's D1/R2
// stand-ins, so this runs under plain `npm test` too, not just Bun.
describe('runRetentionSweepOnce', () => {
  it('deletes an unacknowledged note past the retention window without starting an HTTP server', async () => {
    const base = join(tmpdir(), `olaink-sweep-${randomUUID()}`);
    const databasePath = `${base}.sqlite`;
    const notesPath = `${base}-notes`;
    try {
      // Seed one note with created_at pinned at the epoch, on the same
      // on-disk database/payload directory runRetentionSweepOnce will open.
      const db = SqliteD1.open(databasePath);
      const store = D1Store.open(db);
      const payloads = new DirectoryNotePayloads(notesPath);
      const relay = new PrototypeNoteRelay({ store, payloads, now: () => 0 });
      const alice = await generateDeviceKeyPair('alice-device');
      const bob = await generateDeviceKeyPair('bob-device');
      await relay.registerDevice('alice', alice);
      const directory = await relay.registerDevice('bob', bob);
      const record = await encryptNoteForDevices(
        { filename: 'old.note', mime: 'application/x-supernote', note: Buffer.from('opaque') },
        { fromUserId: 'alice', fromDeviceId: alice.deviceId, toUserId: 'bob', toDirectoryVersion: directory.version, recipients: directory.devices },
      );
      await relay.send(record);
      db.close();

      expect(await runRetentionSweepOnce({ databasePath, notesPath, commit: 'unknown' })).toBe(1);

      const reopened = SqliteD1.open(databasePath);
      expect((await reopened.prepare('SELECT COUNT(*) AS count FROM prototype_notes').all()).results).toEqual([{ count: 0 }]);
      reopened.close();
    } finally {
      for (const suffix of ['.sqlite', '.sqlite-wal', '.sqlite-shm']) await rm(`${base}${suffix}`, { force: true });
      await rm(notesPath, { recursive: true, force: true });
    }
  });

  it('refuses to run without a database path', async () => {
    await expect(runRetentionSweepOnce({ databasePath: '', commit: 'unknown' })).rejects.toThrow('databasePath is required');
  });
});
