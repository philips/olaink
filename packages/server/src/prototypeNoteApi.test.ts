import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptNoteForDevice, encryptNoteForDevices, generateDeviceKeyPair } from './prototypeNoteCrypto.ts';
import { OlainkServer } from './httpApi.ts';

let server: OlainkServer;
let baseUrl: string;
const subjects: Record<string, string> = {
  'Bearer alice': 'authgravity-alice',
  'Bearer bob': 'authgravity-bob',
  'Bearer mallory': 'authgravity-mallory',
};

beforeAll(async () => {
  server = new OlainkServer({
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
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as any };
}

async function claim(token: string, username: string) {
  const result = await request('/v1/account/username', token, { username });
  expect(result.status).toBe(201);
  return result.json.account;
}

describe('authenticated encrypted whole-note API', () => {
  it('routes an opaque note by username and prevents cross-account polling or acknowledgement', async () => {
    const aliceAccount = await claim('Bearer alice', 'alice-inbox');
    const bobAccount = await claim('Bearer bob', 'bob-inbox');
    const alice = generateDeviceKeyPair('alice-device');
    const bob = generateDeviceKeyPair('inbox_bob-device');
    expect((await request('/v1/devices', 'Bearer alice', alice)).status).toBe(201);
    expect((await request('/v1/devices', 'Bearer bob', bob)).status).toBe(201);

    expect((await request('/v1/users/bob-inbox')).status).toBe(401);
    const directory = await request('/v1/users/BOB-INBOX', 'Bearer alice');
    expect(directory.status).toBe(200);
    expect(directory.json.directory.userId).toBe(bobAccount.userId);
    expect(directory.json.directory.devices).toEqual([{ deviceId: bob.deviceId, publicKeySpki: bob.publicKeySpki }]);

    const sent = encryptNoteForDevices(
      { filename: 'private.note', mime: 'application/x-supernote', note: Buffer.from('whole encrypted note') },
      { fromUserId: aliceAccount.userId, fromDeviceId: alice.deviceId, toUserId: directory.json.directory.userId, toDirectoryVersion: directory.json.directory.version, recipients: directory.json.directory.devices },
    );
    const accepted = await request('/v1/notes', 'Bearer alice', { username: 'bob-inbox', record: sent });
    expect(accepted.status).toBe(202);
    expect(accepted.text).not.toContain('private.note');

    expect((await request('/v1/poll', 'Bearer mallory', { deviceId: bob.deviceId })).json.error).toBe('unknown_device');
    const inbox = await request('/v1/poll', 'Bearer bob', { deviceId: bob.deviceId });
    expect(inbox.status).toBe(200);
    expect(inbox.json.records).toHaveLength(1);
    expect(decryptNoteForDevice(inbox.json.records[0], bob)).toMatchObject({ filename: 'private.note', note: Buffer.from('whole encrypted note') });
    expect((await request('/v1/ack', 'Bearer alice', { deviceId: bob.deviceId, recordIds: [sent.id] })).json.error).toBe('unknown_device');
    expect((await request('/v1/ack', 'Bearer bob', { deviceId: bob.deviceId, recordIds: [sent.id] })).json.acknowledged).toBe(1);
    expect((await request('/v1/poll', 'Bearer bob', { deviceId: bob.deviceId })).json.records).toEqual([]);
  });

  it('rejects recipient substitution and stale/incomplete key slots', async () => {
    const alice = generateDeviceKeyPair('alice-device-two');
    await request('/v1/devices', 'Bearer alice', alice);
    const bobDirectory = (await request('/v1/users/bob-inbox', 'Bearer alice')).json.directory;
    const valid = encryptNoteForDevices(
      { filename: 'fixture.note', mime: 'application/x-supernote', note: Buffer.from('fixture') },
      { fromUserId: (await request('/v1/account', 'Bearer alice')).json.account.userId, fromDeviceId: alice.deviceId, toUserId: bobDirectory.userId, toDirectoryVersion: bobDirectory.version, recipients: bobDirectory.devices },
    );
    valid.keySlots = [];
    expect((await request('/v1/notes', 'Bearer alice', { username: 'bob-inbox', record: valid })).json.error).toBe('invalid_note');
    valid.toUserId = 'account_not_bob';
    expect((await request('/v1/notes', 'Bearer alice', { username: 'bob-inbox', record: valid })).json.error).toBe('invalid_note');
  });
});
