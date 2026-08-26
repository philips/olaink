import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDeviceKeyPair } from './prototypeNoteCrypto.ts';
import { OlainkServer } from './httpApi.ts';

let server: OlainkServer;
let baseUrl: string;

beforeAll(async () => {
  server = new OlainkServer({
    authGravity: {
      verify: async (credentials) => credentials.authorization === 'Bearer authgravity-test-token'
        ? { subject: 'authgravity-passkey-owner' }
        : null,
    },
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${server.address()!.port}`;
});

afterAll(async () => server.close());

async function post(path: string, body: unknown, authorization?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as any };
}

describe('AuthGravity pair-code onboarding', () => {
  it('requires an authenticated owner and consumes a code to enroll one WebView device', async () => {
    const primary = generateDeviceKeyPair('primary-device');
    const companion = generateDeviceKeyPair('companion-webview');

    expect((await post('/v1/pairings', { device: primary })).status).toBe(401);
    expect((await post('/v1/pairings', { device: primary }, 'Bearer authgravity-test-token')).status).toBe(409);
    expect((await post('/v1/account/username', { username: 'fixture-owner' }, 'Bearer authgravity-test-token')).status).toBe(201);
    const started = await post('/v1/pairings', { device: primary }, 'Bearer authgravity-test-token');
    expect(started.status).toBe(201);
    expect(started.json.pairing.code).toMatch(/^\d{4}-\d{4}$/);
    expect(started.json.pairing.userId).toMatch(/^account_[a-z2-9]+$/);
    expect(started.json.pairing.userId).not.toContain('passkey');

    const claimed = await post('/v1/pairings/claim', {
      code: started.json.pairing.code.toLowerCase(),
      device: companion,
    });
    expect(claimed.status).toBe(201);
    expect(claimed.json.pairing.userId).toBe(started.json.pairing.userId);
    expect(claimed.json.pairing.directory.devices.map((device: { deviceId: string }) => device.deviceId)
      .sort()).toEqual([primary.deviceId, companion.deviceId].sort());

    expect((await post('/v1/pairings/claim', {
      code: started.json.pairing.code,
      device: generateDeviceKeyPair('second-webview'),
    })).status).toBe(400);

    for (let index = 0; index < 8; index += 1) {
      expect((await post('/v1/pairings/claim', {
        code: '00000000', device: generateDeviceKeyPair(`invalid-${index}`),
      })).status).toBe(400);
    }
    expect((await post('/v1/pairings/claim', {
      code: '00000000', device: generateDeviceKeyPair('rate-limited'),
    })).status).toBe(429);
  });
});
