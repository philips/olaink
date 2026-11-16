import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decryptNoteForDevice,
  decryptNoteForDeviceV2,
  encryptNoteForDevices,
  encryptNoteForDevicesV2,
  generateDeviceKeyPair,
  type DeviceKeyPair,
} from './prototypeNoteCrypto.ts';
import { createTestApp, type TestApp } from './testApp.ts';

/**
 * Record v2 end to end (plans/binary-record-transport.md): multipart sends,
 * header-only polls, per-record blob downloads, capability advertisement,
 * and the v1/v2 coexistence rules. The crypto itself is covered by the
 * interop suites; these tests pin the relay's HTTP and storage contract.
 */

let harness: TestApp;

beforeAll(async () => {
  harness = await createTestApp({
    commit: 'b'.repeat(40),
    // Any Bearer token is its own subject, so every test below gets a
    // fresh account (one subject can only ever hold one username).
    authGravity: { verify: async ({ authorization }) =>
      typeof authorization === 'string' && authorization.startsWith('Bearer ') && authorization.length > 'Bearer '.length
        ? { subject: authorization.slice('Bearer '.length) } : null },
  });
});

afterAll(() => harness.close());

async function post(path: string, body: unknown, authorization?: string) {
  const response = await harness.fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as any };
}

async function postMultipart(path: string, form: FormData, authorization?: string) {
  const response = await harness.fetch(path, {
    method: 'POST',
    headers: authorization ? { Authorization: authorization } : {},
    body: form,
  });
  return { status: response.status, json: (await response.json()) as any };
}

async function get(path: string, authorization?: string) {
  const response = await harness.fetch(path, {
    method: 'GET',
    headers: authorization ? { Authorization: authorization } : {},
  });
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), json: tryJson(response) };
}

async function tryJson(response: Response): Promise<any> {
  try { return await response.json(); } catch { return undefined; }
}

/** A v2 send as a client builds it: username, header JSON, raw blob. */
function noteForm(username: string, header: unknown, blob: Uint8Array, deviceId?: string) {
  const form = new FormData();
  form.append('username', username);
  if (deviceId !== undefined) form.append('deviceId', deviceId);
  form.append('header', JSON.stringify(header));
  form.append('blob', new Blob([blob as Uint8Array<ArrayBuffer>]));
  return form;
}

interface Account {
  userId: string;
  username: string;
  device: DeviceKeyPair;
}

async function enroll(token: string, username: string, payloadVersions?: number[]): Promise<Account> {
  const claimed = await post('/v1/account/username', { username }, token);
  expect(claimed.status).toBeLessThan(300);
  const device = await generateDeviceKeyPair(`inbox_${username}`);
  const enrolled = await post('/v1/devices', { deviceId: device.deviceId, publicKeySpki: device.publicKeySpki, ...(payloadVersions ? { payloadVersions } : {}) }, token);
  expect(enrolled.status).toBeLessThan(300);
  return { userId: claimed.json.account.userId, username, device };
}

async function directoryFor(username: string, token: string) {
  const response = await harness.fetch(`/v1/users/${username}`, { headers: { Authorization: token } });
  expect(response.status).toBe(200);
  return (await response.json() as any).directory;
}

describe('record v2 transport', () => {
  it('sends a v2 record, polls only its header, downloads the blob, and decrypts it', async () => {
    const alice = await enroll('Bearer alice-v2', 'alice-v2');
    const bob = await enroll('Bearer bob-v2', 'bob-v2', [1, 2]);

    // A v2-capable receiver advertises its payload formats through the directory.
    const directory = await directoryFor('bob-v2', 'Bearer alice-v2');
    expect(directory.devices).toEqual([
      { deviceId: bob.device.deviceId, publicKeySpki: bob.device.publicKeySpki, payloadVersions: [1, 2] },
    ]);

    const note = new TextEncoder().encode('whole .note bytes for the v2 transport; '.repeat(64));
    const { header, blob } = await encryptNoteForDevicesV2(
      { filename: 'v2.note', mime: 'application/x-supernote', note, senderUsername: 'alice-v2', encoding: 'gzip' },
      { fromUserId: alice.userId, fromDeviceId: alice.device.deviceId, toUserId: directory.userId, toDirectoryVersion: directory.version, recipients: directory.devices },
    );
    expect(header.ciphertextBytes).toBe(blob.byteLength);
    // The wire saving: the blob is smaller than the pre-gzip note, and no
    // base64 layer ever wraps it.
    expect(blob.byteLength).toBeLessThan(note.byteLength);

    const sent = await postMultipart('/v2/notes', noteForm('bob-v2', header, blob), 'Bearer alice-v2');
    expect(sent.status).toBe(202);
    expect(sent.json).toEqual({ ok: true, id: header.id });

    // The poll response carries the header only — never the ciphertext.
    const polled = await post('/v2/poll', { deviceId: bob.device.deviceId }, 'Bearer bob-v2');
    expect(polled.json.records).toEqual([header]);
    expect(JSON.stringify(polled.json)).not.toContain('whole .note bytes');

    // The blob downloads as raw bytes, only for the device holding the delivery.
    const blobResponse = await get(`/v2/records/${header.id}/blob?deviceId=${bob.device.deviceId}`, 'Bearer bob-v2');
    expect(blobResponse.status).toBe(200);
    expect(blobResponse.bytes).toEqual(blob);
    expect(await decryptNoteForDeviceV2(header, blobResponse.bytes, bob.device)).toMatchObject({
      filename: 'v2.note',
      note,
      senderUsername: 'alice-v2',
    });

    // Acknowledge and confirm the blob is garbage-collected with the record.
    expect((await post('/v1/ack', { deviceId: bob.device.deviceId, recordIds: [header.id] }, 'Bearer bob-v2')).json.acknowledged).toBe(1);
    expect((await get(`/v2/records/${header.id}/blob?deviceId=${bob.device.deviceId}`, 'Bearer bob-v2')).status).toBe(404);
  });

  it('returns a mixed inbox: v1 records inline, v2 records as headers', async () => {
    const alice = await enroll('Bearer alice-mixed', 'alice-mixed');
    const bob = await enroll('Bearer bob-mixed', 'bob-mixed', [1, 2]);

    const directory = await directoryFor('bob-mixed', 'Bearer alice-mixed');
    const options = { fromUserId: alice.userId, fromDeviceId: alice.device.deviceId, toUserId: directory.userId, toDirectoryVersion: directory.version, recipients: directory.devices };
    const v1 = await encryptNoteForDevices(
      { filename: 'legacy.note', mime: 'application/x-supernote', note: new TextEncoder().encode('legacy record') }, options,
    );
    const v2 = await encryptNoteForDevicesV2(
      { filename: 'modern.note', mime: 'application/x-supernote', note: new TextEncoder().encode('modern record') }, options,
    );
    expect((await post('/v1/notes', { username: 'bob-mixed', record: v1 }, 'Bearer alice-mixed')).status).toBe(202);
    expect((await postMultipart('/v2/notes', noteForm('bob-mixed', v2.header, v2.blob), 'Bearer alice-mixed')).status).toBe(202);

    const polled = await post('/v2/poll', { deviceId: bob.device.deviceId }, 'Bearer bob-mixed');
    expect(polled.json.records).toHaveLength(2);
    const versions = polled.json.records.map((record: any) => record.version).sort();
    expect(versions).toEqual([1, 2]);
    const legacy = polled.json.records.find((record: any) => record.version === 1);
    const modern = polled.json.records.find((record: any) => record.version === 2);
    expect(legacy.ciphertext).toBe(v1.ciphertext);
    expect(modern.ciphertextBytes).toBe(v2.header.ciphertextBytes);
    expect(await decryptNoteForDevice(legacy, bob.device)).toMatchObject({ filename: 'legacy.note' });

    // A legacy client polling /v1/poll sees the v1 record; a v2 record it
    // could never receive (capability negotiation) is skipped, not fatal.
    const legacyPoll = await post('/v1/poll', { deviceId: bob.device.deviceId }, 'Bearer bob-mixed');
    expect(legacyPoll.json.records.map((record: any) => record.version)).toEqual([1]);
  });

  it('enforces blob access control and rejects malformed or oversized sends', async () => {
    const alice = await enroll('Bearer alice-acl', 'alice-acl');
    const bob = await enroll('Bearer bob-acl', 'bob-acl', [1, 2]);
    const mallory = await enroll('Bearer mallory-acl', 'mallory-acl');

    const directory = await directoryFor('bob-acl', 'Bearer alice-acl');
    const { header, blob } = await encryptNoteForDevicesV2(
      { filename: 'acl.note', mime: 'application/x-supernote', note: new TextEncoder().encode('acl fixture') },
      { fromUserId: alice.userId, fromDeviceId: alice.device.deviceId, toUserId: directory.userId, toDirectoryVersion: directory.version, recipients: directory.devices },
    );
    await postMultipart('/v2/notes', noteForm('bob-acl', header, blob), 'Bearer alice-acl');

    const url = `/v2/records/${header.id}/blob?deviceId=${bob.device.deviceId}`;
    expect((await get(url)).status).toBe(401);                       // no account auth
    expect((await get(url, 'Bearer mallory-acl')).status).toBe(404);  // not this account's device
    expect((await get(`/v2/records/${header.id}/blob?deviceId=${mallory.device.deviceId}`, 'Bearer mallory-acl')).status).toBe(404);
    expect((await get(`/v2/records/${header.id}/blob?deviceId=${alice.device.deviceId}`, 'Bearer alice-acl')).status).toBe(404); // no delivery for this device

    // A declared length that disagrees with the actual blob is rejected.
    const mismatch = await postMultipart('/v2/notes', noteForm('bob-acl', { ...header, id: 'aclmismatch000000000000000000000001', ciphertextBytes: blob.byteLength + 1 }, blob), 'Bearer alice-acl');
    expect(mismatch.status).toBe(400);

    // An oversized routing header is rejected before any storage work.
    const padded = { ...header, id: 'aclpadded0000000000000000000000001', pad: 'x'.repeat(5 * 1024) };
    const oversized = await postMultipart('/v2/notes', noteForm('bob-acl', padded, blob), 'Bearer alice-acl');
    expect(oversized.status).toBe(413);
    expect(oversized.json).toEqual({ ok: false, error: 'record_too_large' });

    // Garbage multipart never reaches the relay logic.
    const garbage = await harness.fetch('/v2/notes', { method: 'POST', headers: new Headers({ Authorization: 'Bearer alice-acl' }), body: 'not multipart' });
    expect(garbage.status).toBe(400);

    // A re-send of the identical blob is idempotent; a different blob under
    // the same record ID is rejected.
    expect((await postMultipart('/v2/notes', noteForm('bob-acl', header, blob), 'Bearer alice-acl')).status).toBe(202);
    const tampered = new Uint8Array(blob);
    tampered[0] = tampered[0]! ^ 0xff;
    const conflict = await postMultipart('/v2/notes', noteForm('bob-acl', header, tampered), 'Bearer alice-acl');
    expect(conflict.status).not.toBe(202);
  });

  it('serves the companion surface: multipart send, header poll, and blob GET over a device session', async () => {
    const owner = await enroll('Bearer bob-companion', 'bob-companion', [1, 2]);
    const sender = await enroll('Bearer alice-companion', 'alice-companion');

    // Pair a companion device onto bob's account, advertising v2 support.
    const started = await post('/v1/pairings', { device: { deviceId: `companion_${owner.username}`, publicKeySpki: owner.device.publicKeySpki } }, 'Bearer bob-companion');
    expect(started.status).toBeLessThan(300);
    const companion = await generateDeviceKeyPair(`companion_dev_${owner.username}`);
    const claimed = await post('/v1/pairings/claim', {
      code: started.json.pairing.code,
      device: { deviceId: companion.deviceId, publicKeySpki: companion.publicKeySpki, payloadVersions: [1, 2] },
    });
    expect(claimed.status).toBeLessThan(300);
    const session = claimed.json.pairing.deviceSessionToken;

    // The companion sends from its own session device to alice's account.
    const lookedUp = await harness.fetch('/v1/companion/directory', {
      method: 'POST',
      headers: new Headers({ 'X-OlaInk-Device-Session': session, 'Content-Type': 'application/json' }),
      body: JSON.stringify({ deviceId: companion.deviceId, username: 'alice-companion' }),
    });
    expect(lookedUp.status).toBe(200);
    const directory = (await lookedUp.json() as any).directory;
    const { header, blob } = await encryptNoteForDevicesV2(
      { filename: 'companion.note', mime: 'application/x-supernote', note: new TextEncoder().encode('companion fixture') },
      { fromUserId: owner.userId, fromDeviceId: companion.deviceId, toUserId: directory.userId, toDirectoryVersion: directory.version, recipients: directory.devices },
    );

    const sent = await harness.fetch('/v2/companion/notes', {
      method: 'POST',
      headers: new Headers({ 'X-OlaInk-Device-Session': session }),
      body: noteForm('alice-companion', header, blob, companion.deviceId),
    });
    expect(sent.status).toBe(202);

    // The recipient's browser inbox polls v2 and downloads the blob.
    const polled = await post('/v2/poll', { deviceId: sender.device.deviceId }, 'Bearer alice-companion');
    expect(polled.json.records).toEqual([header]);
    const blobResponse = await get(`/v2/records/${header.id}/blob?deviceId=${sender.device.deviceId}`, 'Bearer alice-companion');
    expect(blobResponse.status).toBe(200);
    expect(blobResponse.bytes).toEqual(blob);
    expect(await decryptNoteForDeviceV2(header, blobResponse.bytes, sender.device)).toMatchObject({ filename: 'companion.note' });

    // The companion polls its own (empty) inbox and cannot fetch a blob it
    // does not hold; only the session's own device is authorized.
    const companionPoll = await harness.fetch('/v2/companion/poll', {
      method: 'POST',
      headers: new Headers({ 'X-OlaInk-Device-Session': session, 'Content-Type': 'application/json' }),
      body: JSON.stringify({ deviceId: companion.deviceId }),
    });
    expect((await companionPoll.json() as any).records).toEqual([]);
    expect((await harness.fetch(`/v2/companion/records/${header.id}/blob`, {
      headers: new Headers({ 'X-OlaInk-Device-Session': session }),
    })).status).toBe(404);
    expect((await harness.fetch(`/v2/companion/records/${header.id}/blob`, {
      headers: new Headers({ 'X-OlaInk-Device-Session': 'not-a-session' }),
    })).status).toBe(401);
  });
});
