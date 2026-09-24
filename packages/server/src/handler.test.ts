import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptNoteForDevices, generateDeviceKeyPair } from './prototypeNoteCrypto.ts';
import { createTestApp, type TestApp } from './testApp.ts';

const ORIGIN = 'https://appassets.androidplatform.net';
let harness: TestApp;

beforeEach(async () => {
  harness = await createTestApp({
    commit: 'a'.repeat(40),
    authGravity: { verify: async ({ authorization }) => {
      if (authorization === 'Bearer explode') throw new Error('verifier outage');
      return authorization === 'Bearer owner' ? { subject: 'owner' } : null;
    } },
  });
});

afterEach(() => harness.close());

function post(path: string, body: BodyInit, headers: Record<string, string> = {}, clientAddress = '192.0.2.1') {
  return harness.fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
  }, clientAddress);
}

describe('fetch handler contract', () => {
  it('serves /commit and a fresh CSP nonce per page load', async () => {
    const commit = await harness.fetch('/commit');
    expect(await commit.text()).toBe(`${'a'.repeat(40)}\n`);
    expect(commit.headers.get('cache-control')).toBe('no-store');

    const nonces = await Promise.all([1, 2].map(async () => {
      const page = await harness.fetch('/');
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
    const response = await harness.fetch('/v1/account', { headers: { Authorization: 'Bearer explode' } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'internal' });
  });
});

describe('retention sweep', () => {
  it('runRetentionSweep deletes an unacknowledged note once the app-configured window has passed', async () => {
    let now = 0;
    const sweep = await createTestApp({
      commit: 'a'.repeat(40),
      now: () => now,
      noteRetentionMs: 1_000,
      authGravity: { verify: async ({ authorization }) => {
        if (authorization === 'Bearer alice') return { subject: 'alice' };
        if (authorization === 'Bearer bob') return { subject: 'bob' };
        return null;
      } },
    });
    try {
      const request = async (path: string, token?: string, body?: unknown) => {
        const response = await sweep.fetch(path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, json: await response.json() as any };
      };
      const aliceAccount = (await request('/v1/account/username', 'Bearer alice', { username: 'alice-sweep' })).json.account;
      await request('/v1/account/username', 'Bearer bob', { username: 'bob-sweep' });
      const alice = await generateDeviceKeyPair('alice-device');
      const bob = await generateDeviceKeyPair('bob-device');
      await request('/v1/devices', 'Bearer alice', alice);
      await request('/v1/devices', 'Bearer bob', bob);
      const directory = (await request('/v1/users/bob-sweep', 'Bearer alice')).json.directory;

      const record = await encryptNoteForDevices(
        { filename: 'expires.note', mime: 'application/x-supernote', note: Buffer.from('opaque') },
        { fromUserId: aliceAccount.userId, fromDeviceId: alice.deviceId, toUserId: directory.userId, toDirectoryVersion: directory.version, recipients: directory.devices },
      );
      const sent = await request('/v1/notes', 'Bearer alice', { username: 'bob-sweep', record });
      expect(sent.status).toBe(202);

      expect(await sweep.app.runRetentionSweep()).toBe(0); // not old enough yet
      now = 2_000;
      expect(await sweep.app.runRetentionSweep()).toBe(1);

      const inbox = await request('/v1/poll', 'Bearer bob', { deviceId: bob.deviceId });
      expect(inbox.json.records).toEqual([]);
    } finally {
      await sweep.close();
    }
  });
});
