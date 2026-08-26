import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDeviceKeyPair } from './prototypeNoteCrypto.ts';
import { OlainkServer } from './httpApi.ts';

let server: OlainkServer;
let baseUrl: string;

const subjects: Record<string, string> = {
  'Bearer mira': 'authgravity-mira-subject',
  'Bearer other': 'authgravity-other-subject',
  'Bearer race-one': 'authgravity-race-one',
  'Bearer race-two': 'authgravity-race-two',
};

beforeAll(async () => {
  server = new OlainkServer({
    now: () => 1_700_000_000_000,
    authGravity: { verify: async ({ authorization }) => {
      const subject = typeof authorization === 'string' ? subjects[authorization] : undefined;
      return subject ? { subject } : null;
    } },
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${server.address()!.port}`;
});

afterAll(async () => server.close());

async function request(path: string, token?: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() as any };
}

describe('immutable authenticated account usernames', () => {
  it('creates an opaque account, atomically claims once, and resolves only the active address', async () => {
    expect((await request('/v1/account')).status).toBe(401);
    const initial = await request('/v1/account', 'Bearer mira');
    expect(initial.status).toBe(200);
    expect(initial.json.account).toMatchObject({ username: null });
    expect(initial.json.account.userId).toMatch(/^account_/);
    expect(initial.json.account.userId).not.toContain('mira-subject');

    expect((await request('/v1/account/username', 'Bearer mira', { username: 'mîra' })).json.error).toBe('invalid_username');
    expect((await request('/v1/account/username', 'Bearer mira', { username: 'admin' })).json.error).toBe('reserved_username');
    expect((await request('/v1/account/username', 'Bearer mira', { username: 'Mira-Notes', userId: 'account_someone_else' })).json.error)
      .toBe('invalid_request');

    const claimed = await request('/v1/account/username', 'Bearer mira', { username: 'Mira-Notes' });
    expect(claimed.status).toBe(201);
    expect(claimed.json.account).toMatchObject({ username: 'mira-notes', assignedAt: 1_700_000_000_000 });
    expect((await request('/v1/account/username', 'Bearer mira', { username: 'mira-notes' })).status).toBe(200);
    expect((await request('/v1/account/username', 'Bearer mira', { username: 'different-name' })).json.error)
      .toBe('username_already_assigned');
    expect((await request('/v1/account/username', 'Bearer other', { username: 'mira-notes' })).json.error)
      .toBe('username_unavailable');

    const beforeEnrollment = await request('/v1/users/MIRA-NOTES', 'Bearer mira');
    expect(beforeEnrollment.status).toBe(200);
    expect(beforeEnrollment.json.directory.userId).toBe(initial.json.account.userId);
    expect(beforeEnrollment.json.directory.devices).toEqual([]);
    expect((await request('/v1/users/unknown-user', 'Bearer mira')).status).toBe(404);
  });

  it('allows exactly one concurrent claimant for a username', async () => {
    const results = await Promise.all([
      request('/v1/account/username', 'Bearer race-one', { username: 'contended-name' }),
      request('/v1/account/username', 'Bearer race-two', { username: 'contended-name' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)?.json.error).toBe('username_unavailable');
  });

  it('requires a claimed username before authenticated pairing enrolls a device', async () => {
    const unnamed = await request('/v1/pairings', 'Bearer other', { device: generateDeviceKeyPair('other-device') });
    expect(unnamed).toMatchObject({ status: 409, json: { error: 'username_required' } });

    const primary = generateDeviceKeyPair('mira-primary');
    const paired = await request('/v1/pairings', 'Bearer mira', { device: primary });
    expect(paired.status).toBe(201);
    const resolved = await request('/v1/users/mira-notes', 'Bearer mira');
    expect(resolved.json.directory.devices.map((device: { deviceId: string }) => device.deviceId)).toEqual([primary.deviceId]);
  });
});
