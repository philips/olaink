import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStandalone, type StandaloneServer } from './standalone.ts';

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
