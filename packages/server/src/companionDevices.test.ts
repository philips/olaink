import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptNoteForDevices, generateDeviceKeyPair } from './prototypeNoteCrypto.ts';
import { createTestApp, type TestApp } from './testApp.ts';

let harness: TestApp;

beforeAll(async () => {
  // A strictly increasing clock keeps enrollment (and inventory) order
  // deterministic across fast in-process calls.
  let clock = Date.now();
  harness = await createTestApp({
    now: () => (clock += 1000),
    authGravity: {
      verify: async (credentials) => {
        const authorization = credentials.authorization;
        return typeof authorization === 'string' && authorization.startsWith('Bearer owner-')
          ? { subject: authorization.slice('Bearer '.length) } : null;
      },
    },
  });
});

afterAll(() => harness.close());

const ANDROID_ORIGIN = 'https://appassets.androidplatform.net';

async function post(path: string, body: unknown, options: { session?: string; origin?: string; authorization?: string } = {}) {
  const response = await harness.fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.session ? { 'X-OlaInk-Device-Session': options.session } : {}),
      ...(options.origin ? { Origin: options.origin } : {}),
      ...(options.authorization ? { Authorization: options.authorization } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as any, headers: response.headers };
}

async function get(path: string, authorization?: string) {
  const response = await harness.fetch(path, {
    method: 'GET',
    headers: authorization ? { Authorization: authorization } : {},
  });
  return { status: response.status, json: (await response.json()) as any };
}

/** One owner account: a browser device plus a paired companion. */
async function ownedAccount(username: string, ownerToken: string) {
  const owner = ownerToken;
  expect((await post('/v1/account/username', { username }, { authorization: owner })).status).toBe(201);
  const primary = await generateDeviceKeyPair(`inbox_${username}-primary`);
  // /v1/pairings enrolls the owner's device (the account's primary/browser key).
  const started = await post('/v1/pairings', { device: primary }, { authorization: owner });
  expect(started.status).toBe(201);
  const startedBody = started.json;
  const companion = await generateDeviceKeyPair(`device_e2_${username}`);
  const claimed = await post('/v1/pairings/claim', {
    code: startedBody.pairing.code.toLowerCase(), device: companion,
  });
  expect(claimed.status).toBe(201);
  return {
    username,
    userId: startedBody.pairing.userId,
    ownerToken: owner,
    primary,
    companion,
    session: claimed.json.pairing.deviceSessionToken,
  };
}

async function queueNoteTo(account: Awaited<ReturnType<typeof ownedAccount>>) {
  const directory = (await get(`/v1/users/${account.username}`, account.ownerToken)).json.directory;
  const record = await encryptNoteForDevices(
    { filename: 'queued.note', mime: 'application/x-supernote', note: Buffer.from('queued') },
    {
      fromUserId: account.userId, fromDeviceId: account.companion.deviceId,
      toUserId: directory.userId, toDirectoryVersion: directory.version,
      recipients: directory.devices,
    },
  );
  const response = await post('/v1/companion/notes', {
    deviceId: account.companion.deviceId, username: account.username, record,
  }, { session: account.session });
  expect(response.status).toBe(202);
  return record.id;
}

describe('companion device inventory and removal', () => {
  it('lists the calling device\'s own account with keys, age, and pending counts', async () => {
    const account = await ownedAccount('devlist-owner', 'Bearer owner-devlist');

    expect((await post('/v1/companion/devices', { deviceId: account.companion.deviceId })).status).toBe(401);
    expect((await post('/v1/companion/devices', { deviceId: account.primary.deviceId }, { session: account.session })).status).toBe(401);

    const listed = await post('/v1/companion/devices', { deviceId: account.companion.deviceId }, { session: account.session });
    expect(listed.status).toBe(200);
    expect(listed.json.ok).toBe(true);
    expect(listed.json.username).toBe('devlist-owner');
    expect(listed.json.devices.map((device: { deviceId: string }) => device.deviceId)).toEqual([
      account.primary.deviceId, account.companion.deviceId,
    ]);
    for (const device of listed.json.devices) {
      expect(typeof device.publicKeySpki).toBe('string');
      expect(device.publicKeySpki.length).toBeGreaterThan(20);
      expect(typeof device.addedAt).toBe('number');
      expect(device.pending).toBe(0);
    }

    // A note addressed to the account queues one delivery per device. The
    // companion acknowledges its own copy; the primary's stays pending.
    const queued = await queueNoteTo(account);
    const acked = await post('/v1/companion/ack', {
      deviceId: account.companion.deviceId, recordIds: [queued],
    }, { session: account.session });
    expect(acked.json.acknowledged).toBe(1);
    const afterSend = await post('/v1/companion/devices', { deviceId: account.companion.deviceId }, { session: account.session });
    const pendingByDevice = Object.fromEntries(afterSend.json.devices.map((device: { deviceId: string; pending: number }) => [device.deviceId, device.pending]));
    expect(pendingByDevice[account.primary.deviceId]).toBe(1);
    expect(pendingByDevice[account.companion.deviceId]).toBe(0);
  });

  it('removes another device of the same account, discarding only its deliveries', async () => {
    const account = await ownedAccount('devremove-owner', 'Bearer owner-devremove');
    const recordId = await queueNoteTo(account);

    expect((await post('/v1/companion/devices/remove', { deviceId: account.companion.deviceId }, { session: account.session })).status).toBe(400);
    expect((await post('/v1/companion/devices/remove', { deviceId: account.companion.deviceId, targetDeviceId: account.companion.deviceId }, { session: account.session })).status).toBe(404);
    expect((await post('/v1/companion/devices/remove', { deviceId: account.companion.deviceId, targetDeviceId: 'not-enrolled' }, { session: account.session })).status).toBe(404);

    const removed = await post('/v1/companion/devices/remove', {
      deviceId: account.companion.deviceId, targetDeviceId: account.primary.deviceId,
    }, { session: account.session });
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ ok: true, removed: true });

    const directory = await get(`/v1/users/${account.username}`, account.ownerToken);
    expect(directory.status).toBe(200);
    expect(directory.json.directory.devices.map((device: { deviceId: string }) => device.deviceId))
      .toEqual([account.companion.deviceId]);
    expect(directory.json.directory.version).toBeGreaterThan(1);

    // The removed device's delivery is gone; the same note survives for the
    // companion, whose session is untouched.
    expect((await post('/v1/poll', { deviceId: account.primary.deviceId })).status).toBe(401);
    const companionPoll = await post('/v1/companion/poll', { deviceId: account.companion.deviceId }, { session: account.session });
    expect(companionPoll.status).toBe(200);
    expect(companionPoll.json.records).toHaveLength(1);
    expect(companionPoll.json.records[0].id).toBe(recordId);

    const listed = await post('/v1/companion/devices', { deviceId: account.companion.deviceId }, { session: account.session });
    expect(listed.json.devices).toHaveLength(1);
  });

  it('never removes a device that belongs to another account', async () => {
    const mine = await ownedAccount('devcross-mine', 'Bearer owner-devcross-mine');
    const other = await ownedAccount('devcross-other', 'Bearer owner-devcross-other');

    expect((await post('/v1/companion/devices/remove', {
      deviceId: mine.companion.deviceId, targetDeviceId: other.primary.deviceId,
    }, { session: mine.session })).status).toBe(404);

    const listed = await post('/v1/companion/devices', { deviceId: mine.companion.deviceId }, { session: mine.session });
    expect(listed.json.devices.map((device: { deviceId: string }) => device.deviceId))
      .toEqual([mine.primary.deviceId, mine.companion.deviceId]);
  });

  it('answers the Android origin with CORS headers for the inventory routes', async () => {
    const anonymous = await post('/v1/companion/devices', { deviceId: 'device_e2_cors' }, { origin: ANDROID_ORIGIN });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('access-control-allow-origin')).toBe(ANDROID_ORIGIN);
    expect(anonymous.headers.get('access-control-allow-credentials')).toBe('true');
    expect(anonymous.headers.get('access-control-allow-headers')).toContain('x-olaink-device-session');
    const foreign = await post('/v1/companion/devices', { deviceId: 'device_e2_cors' }, { origin: 'https://example.invalid' });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });
});
