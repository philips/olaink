/**
 * Adversarial tests for the endpoints that delete (ack, companion/logout) or
 * reveal (poll, directory) data. Complements the contract coverage in
 * handler.test.ts / prototypeNoteApi.test.ts / prototypePairing.test.ts with
 * attacker-shaped inputs: cross-principal deletion attempts, token/session
 * confusion, replay after revocation, stale-directory exclusion, sender
 * spoofing, and injection-shaped identifiers. See
 * plans/security-audit-delete-reveal.md for the audit this suite backs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptNoteForDevice, encryptNoteForDevices, generateDeviceKeyPair } from './prototypeNoteCrypto.ts';
import { createTestApp, type TestApp } from './testApp.ts';

const ORIGIN = 'https://appassets.androidplatform.net';
let harness: TestApp;
// Every Bearer token is its own AuthGravity subject/account (no shared map):
// each test picks distinctly-suffixed tokens ('Bearer alice-del', ...) so
// per-test accounts never collide on the one-username-per-account rule.
const BEARER = /^Bearer (.+)$/;

beforeAll(async () => {
  harness = await createTestApp({
    authGravity: { verify: async ({ authorization }) => {
      const match = typeof authorization === 'string' ? BEARER.exec(authorization) : null;
      return match ? { subject: `authgravity-${match[1]}` } : null;
    } },
  });
});

afterAll(() => harness.close());

// Each caller gets its own synthetic client address so tests that hit
// POST /v1/pairings/claim don't share the global per-IP rate-limit bucket
// with unrelated tests in this file (that limiter is deliberately global —
// see d1RateLimiter.ts — and is exercised on its own in handler.test.ts).
let clientAddressCounter = 0;
let pairingClaimAddressCounter = 1;
async function req(path: string, init: { token?: string; deviceSession?: string; origin?: string; body?: unknown; clientAddress?: string } = {}) {
  const response = await harness.fetch(path, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.token ? { Authorization: init.token } : {}),
      ...(init.deviceSession ? { 'X-OlaInk-Device-Session': init.deviceSession } : {}),
      ...(init.origin ? { Origin: init.origin } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }, init.clientAddress ?? `198.51.100.${(clientAddressCounter++ % 250) + 1}`);
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) as any : undefined };
}

async function claim(token: string, username: string) {
  const result = await req('/v1/account/username', { token, body: { username } });
  expect(result.status).toBe(201);
  return result.json.account;
}

/** Registers a device on `token`'s account and returns its keypair + directory. */
async function enroll(token: string, deviceLabel: string) {
  const device = await generateDeviceKeyPair(deviceLabel);
  const result = await req('/v1/devices', { token, body: device });
  expect(result.status).toBe(201);
  return { device, directory: result.json.directory };
}

async function directoryOf(token: string, username: string) {
  const result = await req(`/v1/users/${username}`, { token });
  expect(result.status).toBe(200);
  return result.json.directory;
}

async function sendNote(
  token: string,
  fromUserId: string,
  fromDevice: { deviceId: string; privateKey: CryptoKey; publicKeySpki: string },
  toUsername: string,
  toDirectory: { userId: string; version: number; devices: { deviceId: string; publicKeySpki: string }[] },
  filename: string,
) {
  const record = await encryptNoteForDevices(
    { filename, mime: 'application/x-supernote', note: new TextEncoder().encode(filename) },
    { fromUserId, fromDeviceId: fromDevice.deviceId, toUserId: toDirectory.userId, toDirectoryVersion: toDirectory.version, recipients: toDirectory.devices },
  );
  const sent = await req('/v1/notes', { token, body: { username: toUsername, record } });
  expect(sent.status).toBe(202);
  return record;
}

async function pair(primaryToken: string, primaryDevice: { deviceId: string; publicKeySpki: string }, companionLabel: string) {
  const started = await req('/v1/pairings', { token: primaryToken, body: { device: primaryDevice } });
  expect(started.status).toBe(201);
  const companion = await generateDeviceKeyPair(companionLabel);
  const claimed = await req('/v1/pairings/claim', { body: { code: started.json.pairing.code, device: companion }, clientAddress: `203.0.113.${pairingClaimAddressCounter++}` });
  expect(claimed.status).toBe(201);
  return { companion, deviceSessionToken: claimed.json.pairing.deviceSessionToken as string, userId: started.json.pairing.userId as string };
}

describe('adversarial: deletion boundary (ack, logout)', () => {
  it('a device cannot delete another device\'s pending delivery by guessing/reusing its record ID', async () => {
    const alice = await claim('Bearer alice-del', 'adv-alice-del');
    const bob = await claim('Bearer bob-del', 'adv-bob-del');
    const mallory = await claim('Bearer mallory-del', 'adv-mallory-del');
    const aliceDevice = await enroll('Bearer alice-del', 'adv-alice-device-del');
    const bobDevice = await enroll('Bearer bob-del', 'adv-bob-device-del');
    await enroll('Bearer mallory-del', 'adv-mallory-device-del');

    const bobDirectory = await directoryOf('Bearer alice-del', 'adv-bob-del');
    const record = await sendNote('Bearer alice-del', alice.userId, aliceDevice.device, 'adv-bob-del', bobDirectory, 'secret.note');

    // Mallory does not own bob's device; her own device session cannot ack
    // bob's record even though she knows its ID (e.g. from timing/logging).
    const forged = await req('/v1/ack', { token: 'Bearer mallory-del', body: { deviceId: bobDevice.device.deviceId, recordIds: [record.id] } });
    expect(forged.json.error).toBe('unknown_device');

    // Bob's device still has the note: nothing was deleted.
    const inbox = await req('/v1/poll', { token: 'Bearer bob-del', body: { deviceId: bobDevice.device.deviceId } });
    expect(inbox.json.records).toHaveLength(1);
    void mallory;

    // Cleanup for the next test's clean slate.
    await req('/v1/ack', { token: 'Bearer bob-del', body: { deviceId: bobDevice.device.deviceId, recordIds: [record.id] } });
  });

  it('ack rejects an oversized recordIds array instead of processing it (finding A, fixed)', async () => {
    const bob = await claim('Bearer bob-ack-cap', 'adv-bob-ack-cap');
    const bobDevice = await enroll('Bearer bob-ack-cap', 'adv-bob-device-ack-cap');
    void bob;
    // A large, mostly-nonexistent recordIds array must be rejected outright,
    // not turned into a multi-thousand-statement db.batch().
    const huge = Array.from({ length: 20_000 }, (_, i) => `nonexistent-${i}`);
    const result = await req('/v1/ack', { token: 'Bearer bob-ack-cap', body: { deviceId: bobDevice.device.deviceId, recordIds: huge } });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe('too_many_record_ids');

    // A batch within the cap still works normally.
    const withinCap = Array.from({ length: 500 }, (_, i) => `nonexistent-${i}`);
    const ok = await req('/v1/ack', { token: 'Bearer bob-ack-cap', body: { deviceId: bobDevice.device.deviceId, recordIds: withinCap } });
    expect(ok.status).toBe(200);
    expect(ok.json.acknowledged).toBe(0);
  });

  it('companion ack rejects an oversized recordIds array the same way as the account path', async () => {
    const alice = await claim('Bearer alice-ack-cap', 'adv-alice-ack-cap');
    const primary = await enroll('Bearer alice-ack-cap', 'adv-alice-primary-ack-cap');
    const { companion, deviceSessionToken } = await pair('Bearer alice-ack-cap', primary.device, 'adv-companion-ack-cap');
    void alice;
    const huge = Array.from({ length: 501 }, (_, i) => `nonexistent-${i}`);
    const result = await req('/v1/companion/ack', { deviceSession: deviceSessionToken, body: { deviceId: companion.deviceId, recordIds: huge } });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe('too_many_record_ids');
  });

  it('logout revokes the token for all four companion routes, not just poll', async () => {
    const alice = await claim('Bearer alice-logout', 'adv-alice-logout');
    const aliceDevice = await enroll('Bearer alice-logout', 'adv-alice-primary-logout');
    const { companion, deviceSessionToken } = await pair('Bearer alice-logout', aliceDevice.device, 'adv-companion-logout');
    void alice;

    const loggedOut = await req('/v1/companion/logout', { deviceSession: deviceSessionToken, body: { deviceId: companion.deviceId } });
    expect(loggedOut.status).toBe(200);

    const poll = await req('/v1/companion/poll', { deviceSession: deviceSessionToken, body: { deviceId: companion.deviceId } });
    expect(poll.status).toBe(401);
    const ack = await req('/v1/companion/ack', { deviceSession: deviceSessionToken, body: { deviceId: companion.deviceId, recordIds: ['x'] } });
    expect(ack.status).toBe(401);
    const directory = await req('/v1/companion/directory', { deviceSession: deviceSessionToken, body: { deviceId: companion.deviceId, username: 'adv-alice-logout' } });
    expect(directory.status).toBe(401);
    const notes = await req('/v1/companion/notes', { deviceSession: deviceSessionToken, body: { deviceId: companion.deviceId, username: 'adv-alice-logout', record: {} } });
    expect(notes.status).toBe(401);
  });
});

describe('adversarial: session/token confusion', () => {
  it('a device-session token for device A is rejected when the request names device B, even on the same account', async () => {
    const alice = await claim('Bearer alice-confused', 'adv-alice-confused');
    const primary = await enroll('Bearer alice-confused', 'adv-alice-primary-confused');
    const { deviceSessionToken } = await pair('Bearer alice-confused', primary.device, 'adv-companion-confused');
    void alice;

    // The companion's own token must not authorize the primary device (a
    // real, same-account device) — the "confused deputy" case, distinct
    // from an unrelated account's device.
    const crossDevice = await req('/v1/companion/poll', { deviceSession: deviceSessionToken, body: { deviceId: primary.device.deviceId } });
    expect(crossDevice.status).toBe(401);
    expect(crossDevice.json.error).toBe('invalid_device_session');
  });

  it('unknown_device is identical whether the device never existed or belongs to someone else', async () => {
    const bob = await claim('Bearer bob-enum', 'adv-bob-enum');
    const bobDevice = await enroll('Bearer bob-enum', 'adv-bob-device-enum');
    await claim('Bearer mallory-enum', 'adv-mallory-enum');
    void bob;

    const neverExisted = await req('/v1/poll', { token: 'Bearer mallory-enum', body: { deviceId: 'totally-unregistered-device-id' } });
    const wrongOwner = await req('/v1/poll', { token: 'Bearer mallory-enum', body: { deviceId: bobDevice.device.deviceId } });
    expect(neverExisted.status).toBe(wrongOwner.status);
    expect(neverExisted.json).toEqual(wrongOwner.json);
    expect(neverExisted.json.error).toBe('unknown_device');
  });

  it('companion routes authorize on the device-session token, not the Origin header (CORS is not the auth boundary)', async () => {
    const alice = await claim('Bearer alice-origin', 'adv-alice-origin');
    const primary = await enroll('Bearer alice-origin', 'adv-alice-primary-origin');
    const { companion, deviceSessionToken } = await pair('Bearer alice-origin', primary.device, 'adv-companion-origin');
    void alice;

    // Valid token, no Origin header at all (a non-browser HTTP client):
    // still authorized, because the token is the real capability.
    const noOrigin = await req('/v1/companion/poll', { deviceSession: deviceSessionToken, body: { deviceId: companion.deviceId } });
    expect(noOrigin.status).toBe(200);
    expect(noOrigin.headers.get('access-control-allow-origin')).toBeNull();

    // Forged Android origin, no/invalid token: still rejected.
    const forgedOrigin = await req('/v1/companion/poll', { origin: ORIGIN, body: { deviceId: companion.deviceId } });
    expect(forgedOrigin.status).toBe(401);
  });
});

describe('adversarial: reveal boundary (directory freshness, sender spoofing)', () => {
  it('rejects a note built from a directory snapshot made stale by a newly enrolled recipient device', async () => {
    const alice = await claim('Bearer alice-stale', 'adv-alice-stale');
    const bob = await claim('Bearer bob-stale', 'adv-bob-stale');
    const aliceDevice = await enroll('Bearer alice-stale', 'adv-alice-device-stale');
    await enroll('Bearer bob-stale', 'adv-bob-device-one-stale');
    void bob;

    // Attacker captures the directory before the victim adds a second
    // (e.g. recovery) device.
    const staleDirectory = await directoryOf('Bearer alice-stale', 'adv-bob-stale');
    await enroll('Bearer bob-stale', 'adv-bob-device-two-stale'); // bumps directory version

    const record = await encryptNoteForDevices(
      { filename: 'exclude-second-device.note', mime: 'application/x-supernote', note: new TextEncoder().encode('x') },
      { fromUserId: alice.userId, fromDeviceId: aliceDevice.device.deviceId, toUserId: staleDirectory.userId, toDirectoryVersion: staleDirectory.version, recipients: staleDirectory.devices },
    );
    const result = await req('/v1/notes', { token: 'Bearer alice-stale', body: { username: 'adv-bob-stale', record } });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe('invalid_note');
  });

  it('rejects fromUserId spoofing and leaves no orphaned payload or delivery row', async () => {
    const alice = await claim('Bearer alice-spoof', 'adv-alice-spoof');
    const bob = await claim('Bearer bob-spoof', 'adv-bob-spoof');
    const mallory = await claim('Bearer mallory-spoof', 'adv-mallory-spoof');
    const aliceDevice = await enroll('Bearer alice-spoof', 'adv-alice-device-spoof');
    const bobDevice = await enroll('Bearer bob-spoof', 'adv-bob-device-spoof');
    const malloryDevice = await enroll('Bearer mallory-spoof', 'adv-mallory-device-spoof');
    void aliceDevice;

    const bobDirectory = await directoryOf('Bearer mallory-spoof', 'adv-bob-spoof');
    // Mallory encrypts with her own device but claims alice's userId as the
    // sender, hoping bob will trust "alice" as the origin.
    const record = await encryptNoteForDevices(
      { filename: 'spoofed.note', mime: 'application/x-supernote', note: new TextEncoder().encode('spoof') },
      { fromUserId: alice.userId, fromDeviceId: malloryDevice.device.deviceId, toUserId: bobDirectory.userId, toDirectoryVersion: bobDirectory.version, recipients: bobDirectory.devices },
    );
    const result = await req('/v1/notes', { token: 'Bearer mallory-spoof', body: { username: 'adv-bob-spoof', record } });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe('invalid_note');

    // Bob's inbox is untouched; nothing was queued under the spoofed record.
    const inbox = await req('/v1/poll', { token: 'Bearer bob-spoof', body: { deviceId: bobDevice.device.deviceId } });
    expect(inbox.json.records).toEqual([]);
  });

  it('decrypts correctly only for a genuinely owned device after the legitimate path (control case)', async () => {
    const alice = await claim('Bearer alice-control', 'adv-alice-control');
    const bob = await claim('Bearer bob-control', 'adv-bob-control');
    const aliceDevice = await enroll('Bearer alice-control', 'adv-alice-device-control');
    const bobDevice = await enroll('Bearer bob-control', 'adv-bob-device-control');
    void alice;
    void bob;

    const bobDirectory = await directoryOf('Bearer alice-control', 'adv-bob-control');
    const record = await sendNote('Bearer alice-control', (await req('/v1/account', { token: 'Bearer alice-control' })).json.account.userId,
      aliceDevice.device, 'adv-bob-control', bobDirectory, 'legit.note');
    const inbox = await req('/v1/poll', { token: 'Bearer bob-control', body: { deviceId: bobDevice.device.deviceId } });
    expect(await decryptNoteForDevice(inbox.json.records[0], bobDevice.device)).toMatchObject({ filename: 'legit.note' });
    expect(record.toUserId).toBe(bobDirectory.userId);
  });
});

describe('adversarial: injection-shaped identifiers', () => {
  const payloads = ["' OR '1'='1", '../../etc/passwd', '__proto__', 'constructor', 'a\u0000b', '%00', "'; DROP TABLE prototype_notes; --"];

  it('rejects SQL/path/prototype-pollution-shaped deviceId on poll without 500s or side effects', async () => {
    const bob = await claim('Bearer bob-inject', 'adv-bob-inject');
    void bob;
    for (const payload of payloads) {
      const result = await req('/v1/poll', { token: 'Bearer bob-inject', body: { deviceId: payload } });
      expect(result.status).not.toBe(500);
      expect(result.json.error).toBe('unknown_device');
    }
  });

  it('rejects the same shapes as a pairing code without 500s or granting a session', async () => {
    // One dedicated address per attempt: this test is about input shape, not
    // the rate limiter (that's covered on its own in handler.test.ts).
    for (const payload of payloads) {
      const result = await req('/v1/pairings/claim', { body: { code: payload, device: {} }, clientAddress: `203.0.113.${pairingClaimAddressCounter++}` });
      expect(result.status).not.toBe(500);
      expect(result.status).toBe(400);
    }
  });

  it('rejects injection-shaped recordIds entries on ack without 500s or deleting anything', async () => {
    const bob = await claim('Bearer bob-inject-ack', 'adv-bob-inject-ack');
    const bobDevice = await enroll('Bearer bob-inject-ack', 'adv-bob-device-inject-ack');
    void bob;
    // Well within MAX_ACK_RECORD_IDS: exercises identifier handling, not the
    // length cap (covered separately above).
    const result = await req('/v1/ack', { token: 'Bearer bob-inject-ack', body: { deviceId: bobDevice.device.deviceId, recordIds: payloads } });
    expect(result.status).not.toBe(500);
    expect(result.json.acknowledged).toBe(0);
  });

  it('rejects injection-shaped usernames on the directory lookup without 500s or matching an unrelated account', async () => {
    await claim('Bearer alice-inject-user', 'adv-alice-inject-user');
    for (const payload of payloads) {
      const result = await req(`/v1/users/${encodeURIComponent(payload)}`, { token: 'Bearer alice-inject-user' });
      expect(result.status).not.toBe(500);
      expect(result.json.error).toBe('unknown_user');
    }
  });
});
