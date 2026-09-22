import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1Store } from './d1Store.ts';
import { D1PairingClaimLimiter } from './d1RateLimiter.ts';
import { MemoryNotePayloadStore } from './notePayloads.ts';
import { encryptNoteForDevices, generateDeviceKeyPair, type DeviceKeyPair } from './prototypeNoteCrypto.ts';
import { PrototypeNoteRelay } from './prototypeNoteRelay.ts';
import { SqliteD1 } from './sqliteD1.ts';

let db: SqliteD1;
let store: D1Store;
let payloads: MemoryNotePayloadStore;
let relay: PrototypeNoteRelay;
let logged: unknown[][];

beforeEach(() => {
  db = SqliteD1.open(':memory:');
  store = D1Store.open(db);
  payloads = new MemoryNotePayloadStore();
  logged = [];
  relay = new PrototypeNoteRelay({ store, payloads, log: (...args) => logged.push(args) });
});

afterEach(() => db.close());

async function aliceToBob(bobDevices: DeviceKeyPair[]) {
  const alice = await generateDeviceKeyPair('alice-device');
  await relay.registerDevice('alice', alice);
  let directory = await relay.directory('bob');
  for (const device of bobDevices) directory = await relay.registerDevice('bob', device);
  const record = await encryptNoteForDevices(
    { filename: 'fixture.note', mime: 'application/x-supernote', note: new TextEncoder().encode('opaque') },
    {
      fromUserId: 'alice', fromDeviceId: alice.deviceId, toUserId: 'bob',
      toDirectoryVersion: directory.version, recipients: directory.devices,
    },
  );
  return { alice, record };
}

describe('relay payload storage', () => {
  it('writes the payload once, serves it on poll, and deletes it when the last delivery is acknowledged', async () => {
    const phone = await generateDeviceKeyPair('bob-phone');
    const tablet = await generateDeviceKeyPair('bob-tablet');
    const { record } = await aliceToBob([phone, tablet]);
    const put = vi.spyOn(payloads, 'put');

    await relay.send(record);
    await relay.send(record);
    expect(put).toHaveBeenCalledTimes(1);
    expect(payloads.objects.get(record.id)).toBe(JSON.stringify(record));

    expect(await relay.poll(phone.deviceId)).toEqual([record]);
    expect(await relay.acknowledge(phone.deviceId, [record.id, record.id])).toBe(1);
    expect(await relay.poll(phone.deviceId)).toEqual([]);
    // The un-acked device can still re-fetch the payload.
    expect(payloads.objects.has(record.id)).toBe(true);
    expect(await relay.poll(tablet.deviceId)).toEqual([record]);
    expect(await relay.poll(tablet.deviceId)).toEqual([record]);

    expect(await relay.acknowledge(tablet.deviceId, [record.id])).toBe(1);
    expect(payloads.objects.has(record.id)).toBe(false);
    expect(await relay.acknowledge(tablet.deviceId, [record.id])).toBe(0);
  });

  it('rejects a different record under a used ID without touching the stored payload', async () => {
    const phone = await generateDeviceKeyPair('bob-phone');
    const { alice, record } = await aliceToBob([phone]);
    await relay.send(record);
    const directory = await relay.directory('bob');
    const impostor = await encryptNoteForDevices(
      { filename: 'other.note', mime: 'application/x-supernote', note: new TextEncoder().encode('other') },
      { fromUserId: 'alice', fromDeviceId: alice.deviceId, toUserId: 'bob', toDirectoryVersion: directory.version, recipients: directory.devices },
    );
    impostor.id = record.id;
    await expect(relay.send(impostor)).rejects.toThrow('record ID is already in use');
    expect(await relay.poll(phone.deviceId)).toEqual([record]);
  });

  it('leaves no orphan payload or delivery rows when the metadata write fails', async () => {
    const phone = await generateDeviceKeyPair('bob-phone');
    const { record } = await aliceToBob([phone]);
    vi.spyOn(store, 'enqueue').mockRejectedValueOnce(new Error('D1 unavailable'));
    await expect(relay.send(record)).rejects.toThrow('D1 unavailable');
    expect(payloads.objects.size).toBe(0);
    expect(await relay.poll(phone.deviceId)).toEqual([]);

    // The same record can be sent again once storage recovers.
    await relay.send(record);
    expect(await relay.poll(phone.deviceId)).toEqual([record]);
  });

  it('garbage-collects payloads whose last recipient device is unregistered', async () => {
    const phone = await generateDeviceKeyPair('bob-phone');
    const { record } = await aliceToBob([phone]);
    await relay.send(record);
    expect(await relay.unregisterDevice(phone.deviceId)).toBe(true);
    expect(payloads.objects.size).toBe(0);
    expect(await relay.unregisterDevice(phone.deviceId)).toBe(false);
  });

  it('logs, but does not fail the request on, a payload delete failure', async () => {
    const phone = await generateDeviceKeyPair('bob-phone');
    const { record } = await aliceToBob([phone]);
    await relay.send(record);
    vi.spyOn(payloads, 'delete').mockRejectedValueOnce(new Error('R2 unavailable'));
    expect(await relay.acknowledge(phone.deviceId, [record.id])).toBe(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(record.id);
  });

  it('rejects device keys that fail full WebCrypto validation', async () => {
    const valid = await generateDeviceKeyPair('bob-phone');
    // Flip a coordinate byte: still well-formed SPKI DER, but not on P-256.
    const bytes = Uint8Array.from(atob(valid.publicKeySpki.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1]! ^= 0x01;
    const offCurve = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expect(relay.registerDevice('bob', { deviceId: 'bob-phone', publicKeySpki: offCurve }))
      .rejects.toThrow('public key is not P-256');
  });
});

describe('D1 pairing-claim limiter', () => {
  it('allows the configured attempts per client and window, then resets', async () => {
    let now = 120_000;
    const limiter = new D1PairingClaimLimiter(db, 3, 60_000, () => now);
    expect([await limiter.hit('1.2.3.4'), await limiter.hit('1.2.3.4'), await limiter.hit('1.2.3.4')])
      .toEqual([true, true, true]);
    expect(await limiter.hit('1.2.3.4')).toBe(false);
    expect(await limiter.hit('5.6.7.8')).toBe(true);
    now += 60_000;
    expect(await limiter.hit('1.2.3.4')).toBe(true);
    // Expired windows are pruned as new ones open.
    expect(await db.prepare('SELECT COUNT(*) AS count FROM pairing_claim_buckets WHERE window_start < ?')
      .bind(180_000).first('count')).toBe(0);
  });
});
