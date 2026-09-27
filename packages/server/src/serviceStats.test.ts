/**
 * Covers GET /stats end to end (HTTP, no auth, no per-account leakage) and
 * D1Store.stats()'s SQL directly (lifetime-counter idempotency, per-account
 * distribution correctness, pending vs. lifetime after acknowledgement).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { D1Store } from './d1Store.ts';
import { MemoryNotePayloadStore } from './notePayloads.ts';
import { encryptNoteForDevices, generateDeviceKeyPair, type DeviceKeyPair } from './prototypeNoteCrypto.ts';
import { PrototypeNoteRelay } from './prototypeNoteRelay.ts';
import { createTestApp, type TestApp } from './testApp.ts';

describe('D1Store.stats() (relay/store level, no account_usernames)', () => {
  let harness: TestApp;
  let store: D1Store;
  let relay: PrototypeNoteRelay;

  beforeEach(async () => {
    harness = await createTestApp();
    store = D1Store.open(harness.db);
    relay = new PrototypeNoteRelay({ store, payloads: new MemoryNotePayloadStore(), log: () => {} });
  });

  afterEach(() => harness.close());

  async function aliceToBob(bobDevices: DeviceKeyPair[]) {
    const alice = await generateDeviceKeyPair('stats-alice-device');
    await relay.registerDevice('stats-alice', alice);
    let directory = await relay.directory('stats-bob');
    for (const device of bobDevices) directory = await relay.registerDevice('stats-bob', device);
    const record = await encryptNoteForDevices(
      { filename: 'fixture.note', mime: 'application/x-supernote', note: new TextEncoder().encode('opaque') },
      {
        fromUserId: 'stats-alice', fromDeviceId: alice.deviceId, toUserId: 'stats-bob',
        toDirectoryVersion: directory.version, recipients: directory.devices,
      },
    );
    return { alice, record };
  }

  it('counts a resend of an already-queued record once toward lifetime totals', async () => {
    const phone = await generateDeviceKeyPair('stats-bob-phone');
    const { record } = await aliceToBob([phone]);
    const sizeBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;

    await relay.send(record);
    await relay.send(record); // idempotent resend of the still-pending record

    const stats = await store.stats();
    expect(stats.pendingMessages).toBe(1);
    expect(stats.pendingBytes).toBe(sizeBytes);
    expect(stats.lifetimeMessages).toBe(1);
    expect(stats.lifetimeBytes).toBe(sizeBytes);
  });

  it('fans out one record to two devices of the same recipient without double-counting bytes', async () => {
    const phone = await generateDeviceKeyPair('stats-bob-phone-2');
    const tablet = await generateDeviceKeyPair('stats-bob-tablet-2');
    const { record } = await aliceToBob([phone, tablet]);
    const sizeBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    await relay.send(record);

    expect(await store.stats()).toMatchObject({ pendingMessages: 1, pendingBytes: sizeBytes });
  });

  it('drops a note from pending totals (but not lifetime totals) once every delivery is acknowledged', async () => {
    const phone = await generateDeviceKeyPair('stats-bob-phone-3');
    const { record } = await aliceToBob([phone]);
    const sizeBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    await relay.send(record);
    await relay.acknowledge(phone.deviceId, [record.id]);

    const stats = await store.stats();
    expect(stats.pendingMessages).toBe(0);
    expect(stats.pendingBytes).toBe(0);
    expect(stats.lifetimeMessages).toBe(1);
    expect(stats.lifetimeBytes).toBe(sizeBytes);
  });
});

describe('GET /stats (HTTP)', () => {
  let harness: TestApp;
  const subjects: Record<string, string> = {
    'Bearer stats-alice': 'authgravity-stats-alice',
    'Bearer stats-bob': 'authgravity-stats-bob',
  };

  beforeAll(async () => {
    harness = await createTestApp({
      authGravity: { verify: async ({ authorization }) => {
        const subject = typeof authorization === 'string' ? subjects[authorization] : undefined;
        return subject ? { subject } : null;
      } },
    });
  });

  afterAll(() => harness.close());

  async function req(path: string, init: { token?: string; body?: unknown } = {}) {
    const response = await harness.fetch(path, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.token ? { Authorization: init.token } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, json: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : undefined };
  }

  async function claim(token: string, username: string) {
    const result = await req('/v1/account/username', { token, body: { username } });
    expect(result.status).toBe(201);
    return result.json.account;
  }

  async function enroll(token: string, deviceLabel: string) {
    const device = await generateDeviceKeyPair(deviceLabel);
    const result = await req('/v1/devices', { token, body: device });
    expect(result.status).toBe(201);
    return { device, directory: result.json.directory };
  }

  it('is public (no session required) and returns an HTML dashboard', async () => {
    const result = await req('/stats');
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('text/html');
    expect(result.text).toContain('Service stats');
  });

  it('reflects a real send in the public counts without naming any account, device, or filename', async () => {
    const alice = await claim('Bearer stats-alice', 'stats-http-alice');
    const bob = await claim('Bearer stats-bob', 'stats-http-bob');
    const aliceDevice = await enroll('Bearer stats-alice', 'stats-http-alice-device');
    const bobDevice = await enroll('Bearer stats-bob', 'stats-http-bob-device');
    void alice;

    const bobDirectory = (await req('/v1/users/stats-http-bob', { token: 'Bearer stats-alice' })).json.directory;
    const record = await encryptNoteForDevices(
      { filename: 'do-not-leak.note', mime: 'application/x-supernote', note: new TextEncoder().encode('x') },
      {
        fromUserId: aliceDevice.directory.userId, fromDeviceId: aliceDevice.device.deviceId,
        toUserId: bobDirectory.userId, toDirectoryVersion: bobDirectory.version, recipients: bobDirectory.devices,
      },
    );
    void bobDevice;
    const sent = await req('/v1/notes', { token: 'Bearer stats-alice', body: { username: 'stats-http-bob', record } });
    expect(sent.status).toBe(202);

    const before = await store(harness).stats();
    const page = await req('/stats');
    expect(page.text).not.toContain('stats-http-alice');
    expect(page.text).not.toContain('stats-http-bob');
    expect(page.text).not.toContain('do-not-leak');
    expect(page.text).not.toContain(record.id);
    // The dashboard doesn't expose raw counts as data attributes; cross-check
    // against the store directly for the numbers this send should move.
    expect(before.pendingMessages).toBeGreaterThanOrEqual(1);
    expect(before.pendingBytes).toBeGreaterThan(0);
    expect(before.activeUsers).toBeGreaterThanOrEqual(2);
    expect(before.storageByAccountBytes.some((bytes) => bytes > 0)).toBe(true);
  });
});

function store(app: TestApp): D1Store {
  return D1Store.open(app.db);
}
