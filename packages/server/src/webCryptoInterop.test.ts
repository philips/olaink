import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptNoteForDevice as decryptWithPi, generateDeviceKeyPair as generatePiDeviceKeyPair } from '../../pi-plugin/recordCrypto.ts';
import {
  decryptNoteForDevice,
  decryptNoteForDeviceV2,
  encryptNoteForDevices,
  encryptNoteForDevicesV2,
  generateDeviceKeyPair,
  type DeviceKeyPair,
  type EncryptedNoteRecordV1,
  type RecordRouting,
} from './prototypeNoteCrypto.ts';

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64(value: Uint8Array): string { return Buffer.from(value).toString('base64url'); }
function bytes(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64url')); }
function source(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
function aad(record: Pick<EncryptedNoteRecordV1, 'id' | 'toUserId' | 'toDirectoryVersion'>): Uint8Array {
  return encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}`);
}
function slotAad(record: Pick<EncryptedNoteRecordV1, 'id' | 'toUserId' | 'toDirectoryVersion'>, deviceId: string): Uint8Array {
  return encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}\0${deviceId}`);
}

/** The browser inbox's WebCrypto wire-format counterpart, kept independently
 * of Node's `prototypeNoteCrypto.ts` so vectors catch contract drift. */
async function decryptLikeBrowser(record: EncryptedNoteRecordV1, device: DeviceKeyPair) {
  const slot = record.keySlots.find((item) => item.deviceId === device.deviceId);
  if (!slot) throw new Error('no recipient key slot');
  const pkcs8 = await subtle.exportKey('pkcs8', device.privateKey);
  const privateKey = await subtle.importKey(
    'pkcs8',
    source(new Uint8Array(pkcs8)),
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
  );
  const peer = await subtle.importKey('spki', source(bytes(slot.ephemeralPublicKeySpki)), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const material = await subtle.importKey('raw', source(new Uint8Array(bits)), 'HKDF', false, ['deriveKey']);
  const wrapKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: source(new Uint8Array()), info: source(aad(record)) }, material,
    { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const contentKey = new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv: source(bytes(slot.wrapIv)), additionalData: source(slotAad(record, device.deviceId)) }, wrapKey, source(bytes(slot.wrappedContentKey)),
  ));
  if (contentKey.byteLength !== 32) throw new Error('invalid content key');
  const content = await subtle.importKey('raw', source(contentKey), 'AES-GCM', false, ['decrypt']);
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: source(bytes(record.contentIv)), additionalData: source(aad(record)) }, content, source(bytes(record.ciphertext)),
  );
  const payload = JSON.parse(decoder.decode(plain));
  const note = bytes(payload.note);
  const hash = b64(new Uint8Array(await subtle.digest('SHA-256', source(note))));
  if (payload.sha256 !== hash) throw new Error('hash mismatch');
  return { ...payload, note };
}

describe('browser WebCrypto interoperability', () => {
  it('decrypts a Node-encrypted P-256/HKDF/AES-GCM note and validates its hash', async () => {
    const receiver = await generateDeviceKeyPair('inbox_vector');
    const note = Buffer.from('whole .note fixture; never page/stroke data');
    const record = await encryptNoteForDevices(
      { filename: 'vector.note', mime: 'application/x-supernote', note },
      { fromUserId: 'account_sender', fromDeviceId: 'sender_device', toUserId: 'account_receiver', toDirectoryVersion: 1, recipients: [receiver] },
    );
    const payload = await decryptLikeBrowser(record, receiver);
    expect(payload).toMatchObject({ version: 1, filename: 'vector.note', mime: 'application/x-supernote' });
    expect(Buffer.from(payload.note)).toEqual(note);
  });

  it('decrypts a relay-encrypted note with the self-contained Pi package crypto', async () => {
    const receiver = await generatePiDeviceKeyPair('pi_vector');
    const note = Buffer.from('whole .note fixture for Pi; never page/stroke data');
    const record = await encryptNoteForDevices(
      { filename: 'pi-vector.note', mime: 'application/x-supernote', note },
      { fromUserId: 'account_sender', fromDeviceId: 'sender_device', toUserId: 'account_receiver', toDirectoryVersion: 1, recipients: [receiver] },
    );
    const payload = await decryptWithPi(record, receiver);
    expect(payload).toMatchObject({ filename: 'pi-vector.note', mime: 'application/x-supernote' });
    expect(Buffer.from(payload.note)).toEqual(note);
  });

  it('rejects an altered authenticated ciphertext', async () => {
    const receiver = await generateDeviceKeyPair('inbox_tamper');
    const record = await encryptNoteForDevices(
      { filename: 'vector.note', mime: 'application/x-supernote', note: Buffer.from('fixture') },
      { fromUserId: 'account_sender', fromDeviceId: 'sender_device', toUserId: 'account_receiver', toDirectoryVersion: 1, recipients: [receiver] },
    );
    record.ciphertext = `${record.ciphertext.slice(0, -1)}${record.ciphertext.endsWith('A') ? 'B' : 'A'}`;
    await expect(decryptLikeBrowser(record, receiver)).rejects.toThrow();
  });
});

describe('record v2 payload codec', () => {
  const note = new TextEncoder().encode('whole .note v2 codec fixture; '.repeat(24));

  async function v2Fixture() {
    const receiver = await generateDeviceKeyPair('inbox_v2codec');
    const encrypted = await encryptNoteForDevicesV2(
      { filename: 'v2-codec.note', mime: 'application/x-supernote', note, senderUsername: 'v2-sender', encoding: 'gzip' },
      { fromUserId: 'account_sender', fromDeviceId: 'sender_device', toUserId: 'account_receiver', toDirectoryVersion: 1, recipients: [receiver] },
    );
    return { receiver, ...encrypted };
  }

  it('round-trips a v2 record through header + raw blob and restores the note', async () => {
    const { receiver, header, blob } = await v2Fixture();
    expect(header.version).toBe(2);
    expect(header.ciphertextBytes).toBe(blob.byteLength);
    const payload = await decryptNoteForDeviceV2(header, blob, receiver);
    expect(payload).toMatchObject({ filename: 'v2-codec.note', mime: 'application/x-supernote', senderUsername: 'v2-sender' });
    expect(payload.note).toEqual(note);
  });

  it('decrypts a legacy v1 record through the v2 decryptor (payload dispatch)', async () => {
    // The v2 decryptor's payload dispatch accepts both payload formats, so a
    // v2-capable receiver keeps reading legacy records unchanged.
    const receiver = await generateDeviceKeyPair('inbox_v2legacy');
    const legacy = await encryptNoteForDevices(
      { filename: 'legacy.note', mime: 'application/x-supernote', note },
      { fromUserId: 'account_sender', fromDeviceId: 'sender_device', toUserId: 'account_receiver', toDirectoryVersion: 1, recipients: [receiver] },
    );
    const legacyPayload = await decryptNoteForDeviceV2(legacy, Buffer.from(legacy.ciphertext, 'base64url'), receiver);
    expect(legacyPayload.note).toEqual(note);
  });

  it('rejects tampered blobs, lying header lengths, and bombs past the device ceiling', async () => {
    const { receiver, header, blob } = await v2Fixture();
    const tampered = new Uint8Array(blob);
    tampered[0] = tampered[0]! ^ 0xff;
    await expect(decryptNoteForDeviceV2(header, tampered, receiver)).rejects.toThrow();

    // A forged plaintext that GCM-authenticates but carries a lying u32
    // header length is rejected by the frame's only hand-rolled check —
    // the frame parses before any field is trusted. Seal with the real
    // content key so the failure is attributable to the frame, not GCM.
    const contentKey = await unwrapContentKey(header, receiver);
    const seal = async (plain: Uint8Array) => new Uint8Array(await subtle.encrypt(
      { name: 'AES-GCM', iv: source(bytes(header.contentIv)), additionalData: source(aad(header as unknown as EncryptedNoteRecordV1)) },
      await subtle.importKey('raw', source(contentKey), 'AES-GCM', false, ['encrypt']), source(plain),
    ));
    // The frame rejects synchronously (before its first await), which trips
    // vitest's unhandled-rejection detector; mark the attempt handled up front.
    const expectFrameRejected = async (sealed: Uint8Array) => {
      const attempt = decryptNoteForDeviceV2(header, sealed, receiver);
      attempt.catch(() => undefined);
      await expect(attempt).rejects.toThrow(/invalid encrypted note payload/);
    };
    const badLength = new Uint8Array(9);
    badLength[0] = 0x02;
    new DataView(badLength.buffer).setUint32(1, 0x7fffffff, true);
    await expectFrameRejected(await seal(badLength));
    await expectFrameRejected(await seal(new Uint8Array([0x7f, 0x01])));
  });
});

/** Unwraps a record's content key with the browser-style independent implementation. */
async function unwrapContentKey(record: RecordRouting, device: DeviceKeyPair): Promise<Uint8Array> {
  const slot = record.keySlots.find((item) => item.deviceId === device.deviceId);
  if (!slot) throw new Error('no recipient key slot');
  const pkcs8 = await subtle.exportKey('pkcs8', device.privateKey);
  const privateKey = await subtle.importKey('pkcs8', source(new Uint8Array(pkcs8)), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const peer = await subtle.importKey('spki', source(bytes(slot.ephemeralPublicKeySpki)), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const material = await subtle.importKey('raw', source(new Uint8Array(bits)), 'HKDF', false, ['deriveKey']);
  const wrapKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: source(new Uint8Array()), info: source(aad(record)) }, material,
    { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  return new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv: source(bytes(slot.wrapIv)), additionalData: source(slotAad(record, device.deviceId)) }, wrapKey, source(bytes(slot.wrappedContentKey)),
  ));
}

describe('committed record-v2 interop vectors', async () => {
  // The workerd test sandbox cannot read repo files; the same test runs in
  // the node pool (and the Java suite decrypts the same vectors).
  const vectorsFile = await import('node:fs/promises').then(
    ({ readFile }) => readFile(new URL('../../plugin/vectors/note-v2-vectors.json', import.meta.url), 'utf8').catch(() => null),
    () => null,
  );
  (vectorsFile === null ? it.skip : it)('the reference decryptor opens the pinned WebCrypto v2 vector', async () => {
    const vectors = JSON.parse(vectorsFile!);
    const deterministic = vectors.deterministic;
    const header = JSON.parse(deterministic.expectedHeaderJson);
    expect(header.ciphertextBytes).toBe(Buffer.from(deterministic.expectedBlobB64url, 'base64url').length);
    for (const recipient of deterministic.recipients) {
      const privateKey = await subtle.importKey(
        'pkcs8', source(bytes(recipient.privatePkcs8B64url)), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
      );
      // The reference decryptor takes a CryptoKey device pair; rebuild one around the vector key.
      const device = { deviceId: recipient.deviceId, publicKeySpki: recipient.publicSpkiB64url, privateKey } as unknown as DeviceKeyPair;
      const payload = await decryptNoteForDeviceV2(header, bytes(deterministic.expectedBlobB64url), device);
      expect(payload).toMatchObject({
        filename: deterministic.payloadInputs.filename,
        senderUsername: deterministic.payloadInputs.senderUsername,
        sha256: deterministic.payloadInputs.noteSha256B64url,
      });
      expect(payload.note).toEqual(bytes(deterministic.payloadInputs.noteB64url));
    }
  });
});
