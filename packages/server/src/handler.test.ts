import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OlainkApp } from './handler.ts';
import { MemoryNotePayloadStore } from './notePayloads.ts';
import { SqliteD1 } from './sqliteD1.ts';

const ORIGIN = 'https://appassets.androidplatform.net';
let db: SqliteD1;
let app: OlainkApp;

beforeEach(() => {
  db = SqliteD1.open(':memory:');
  app = new OlainkApp({
    db,
    payloads: new MemoryNotePayloadStore(),
    commit: 'a'.repeat(40),
    authGravity: { verify: async ({ authorization }) => authorization === 'Bearer owner' ? { subject: 'owner' } : null },
    log: () => {},
  });
});

afterEach(() => db.close());

function post(path: string, body: BodyInit, headers: Record<string, string> = {}, clientAddress = '192.0.2.1') {
  return app.fetch(new Request(`https://app.olaink.com${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
  }), clientAddress);
}

describe('fetch handler contract', () => {
  it('serves /commit and a fresh CSP nonce per page load', async () => {
    const commit = await app.fetch(new Request('https://app.olaink.com/commit'), '192.0.2.1');
    expect(await commit.text()).toBe(`${'a'.repeat(40)}\n`);
    expect(commit.headers.get('cache-control')).toBe('no-store');

    const nonces = await Promise.all([1, 2].map(async () => {
      const page = await app.fetch(new Request('https://app.olaink.com/'), '192.0.2.1');
      const nonce = /'nonce-([^']+)'/.exec(page.headers.get('content-security-policy') ?? '')?.[1];
      expect(await page.text()).toContain(`nonce="${nonce}"`);
      return nonce;
    }));
    expect(nonces[0]).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('rejects malformed and over-cap bodies as bad_request, oversized records as 413', async () => {
    expect((await post('/v1/notes', '{not json')).status).toBe(400);
    const huge = await post('/v1/notes', 'x'.repeat(10 * 1024 * 1024 + 1));
    expect(huge.status).toBe(400);
    expect(await huge.json()).toEqual({ ok: false, error: 'bad_request' });

    const oversized = await post('/v1/notes', JSON.stringify({ username: 'someone', record: { pad: 'x'.repeat(8 * 1024 * 1024) } }),
      { Authorization: 'Bearer owner' });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ ok: false, error: 'record_too_large' });
  });

  it('adds CORS headers to companion responses from the Android origin only', async () => {
    const companion = await post('/v1/companion/poll', '{}', { Origin: ORIGIN });
    expect(companion.status).toBe(401);
    expect(companion.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(companion.headers.get('access-control-allow-credentials')).toBe('true');
    expect(companion.headers.get('vary')).toBe('Origin');

    const account = await post('/v1/poll', '{}', { Origin: ORIGIN });
    expect(account.headers.get('access-control-allow-origin')).toBeNull();
    const foreign = await post('/v1/companion/poll', '{}', { Origin: 'https://example.invalid' });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rate-limits pairing claims per client address', async () => {
    const claim = (address: string) => post('/v1/pairings/claim', JSON.stringify({ code: '00000000', device: {} }), {}, address);
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await claim('192.0.2.1')).status).toBe(400);
    expect((await claim('192.0.2.1')).status).toBe(429);
    expect((await claim('192.0.2.2')).status).toBe(400);
  });

  it('turns an unexpected failure into a JSON 500', async () => {
    db.close();
    const response = await app.fetch(new Request('https://app.olaink.com/v1/account', {
      headers: { Authorization: 'Bearer owner' },
    }), '192.0.2.1');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'internal' });
    db = SqliteD1.open(':memory:');
  });
});
