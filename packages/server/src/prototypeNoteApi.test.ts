import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptNoteForDevice, encryptNoteForDevices, generateDeviceKeyPair } from './prototypeNoteCrypto.ts';
import { WrtnServer } from './httpApi.ts';

let server: WrtnServer;
let baseUrl: string;

beforeAll(async () => {
  server = new WrtnServer();
  await server.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${server.address()!.port}`;
});

afterAll(async () => server.close());

async function request(path: string, init?: RequestInit): Promise<{ status: number; json: any; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) };
}

async function post(path: string, body: unknown) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('encrypted whole-note prototype API', () => {
  it('echo decrypts a note addressed to it and returns a newly encrypted note', async () => {
    const alice = generateDeviceKeyPair('alice-prototype-device');
    const registration = await post('/v1/prototype/devices', {
      userId: 'alice',
      deviceId: alice.deviceId,
      publicKeySpki: alice.publicKeySpki,
    });
    expect(registration.status).toBe(200);
    expect(registration.json.directory.version).toBe(1);

    const echo = await request('/v1/prototype/devices/echo');
    expect(echo.status).toBe(200);
    const echoDirectory = echo.json.directory;
    expect(echoDirectory.devices).toHaveLength(1);

    const noteBytes = Buffer.from('not a page or stroke payload');
    const sent = encryptNoteForDevices(
      { filename: 'private.note', mime: 'application/x-supernote', note: noteBytes },
      {
        fromUserId: 'alice',
        fromDeviceId: alice.deviceId,
        toUserId: 'echo',
        toDirectoryVersion: echoDirectory.version,
        recipients: echoDirectory.devices,
      },
    );
    const accepted = await post('/v1/prototype/notes', { record: sent });
    expect(accepted.status).toBe(202);
    // The relay response and JSON record do not expose the filename or note body.
    expect(accepted.text).not.toContain('private.note');
    expect(JSON.stringify(sent)).not.toContain('private.note');

    const inbox = await post('/v1/prototype/poll', { deviceId: alice.deviceId });
    expect(inbox.status).toBe(200);
    expect(inbox.json.records).toHaveLength(1);
    const reply = inbox.json.records[0];
    expect(reply.fromUserId).toBe('echo');
    expect(reply.toUserId).toBe('alice');
    expect(JSON.stringify(reply)).not.toContain('private.note');

    const echoed = decryptNoteForDevice(reply, alice);
    expect(echoed.filename).toBe('private.note');
    expect(echoed.mime).toBe('application/x-supernote');
    expect(echoed.note).toEqual(noteBytes);

    const ack = await post('/v1/prototype/ack', { deviceId: alice.deviceId, recordIds: [reply.id] });
    expect(ack.status).toBe(200);
    expect(ack.json.acknowledged).toBe(1);
    expect((await post('/v1/prototype/poll', { deviceId: alice.deviceId })).json.records).toEqual([]);
  });

  it('rejects a record whose slots do not exactly match the recipient directory', async () => {
    const bob = generateDeviceKeyPair('bob-prototype-device');
    await post('/v1/prototype/devices', {
      userId: 'bob', deviceId: bob.deviceId, publicKeySpki: bob.publicKeySpki,
    });
    const echo = (await request('/v1/prototype/devices/echo')).json.directory;
    const valid = encryptNoteForDevices(
      { filename: 'fixture.note', mime: 'application/x-supernote', note: Buffer.from('fixture') },
      {
        fromUserId: 'bob', fromDeviceId: bob.deviceId, toUserId: 'echo',
        toDirectoryVersion: echo.version, recipients: echo.devices,
      },
    );
    valid.keySlots = [];
    const rejected = await post('/v1/prototype/notes', { record: valid });
    expect(rejected.status).toBe(400);
    expect(rejected.json.error).toBe('invalid_note');
  });
});
