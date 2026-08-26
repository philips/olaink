import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptNoteForDevices, generateDeviceKeyPair, type EncryptedNoteRecordV1 } from './prototypeNoteCrypto.ts';

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64(value: Uint8Array): string { return Buffer.from(value).toString('base64url'); }
function bytes(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64url')); }
function source(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
function aad(record: EncryptedNoteRecordV1): Uint8Array {
  return encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}`);
}
function slotAad(record: EncryptedNoteRecordV1, deviceId: string): Uint8Array {
  return encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}\0${deviceId}`);
}

/** The browser inbox's WebCrypto wire-format counterpart, kept independently
 * of Node's `prototypeNoteCrypto.ts` so vectors catch contract drift. */
async function decryptLikeBrowser(record: EncryptedNoteRecordV1, device: ReturnType<typeof generateDeviceKeyPair>) {
  const slot = record.keySlots.find((item) => item.deviceId === device.deviceId);
  if (!slot) throw new Error('no recipient key slot');
  const privateKey = await subtle.importKey(
    'pkcs8',
    source(new Uint8Array(device.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer)),
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
    const receiver = generateDeviceKeyPair('inbox_vector');
    const note = Buffer.from('whole .note fixture; never page/stroke data');
    const record = encryptNoteForDevices(
      { filename: 'vector.note', mime: 'application/x-supernote', note },
      { fromUserId: 'account_sender', fromDeviceId: 'sender_device', toUserId: 'account_receiver', toDirectoryVersion: 1, recipients: [receiver] },
    );
    const payload = await decryptLikeBrowser(record, receiver);
    expect(payload).toMatchObject({ version: 1, filename: 'vector.note', mime: 'application/x-supernote' });
    expect(Buffer.from(payload.note)).toEqual(note);
  });

  it('rejects an altered authenticated ciphertext', async () => {
    const receiver = generateDeviceKeyPair('inbox_tamper');
    const record = encryptNoteForDevices(
      { filename: 'vector.note', mime: 'application/x-supernote', note: Buffer.from('fixture') },
      { fromUserId: 'account_sender', fromDeviceId: 'sender_device', toUserId: 'account_receiver', toDirectoryVersion: 1, recipients: [receiver] },
    );
    record.ciphertext = `${record.ciphertext.slice(0, -1)}${record.ciphertext.endsWith('A') ? 'B' : 'A'}`;
    await expect(decryptLikeBrowser(record, receiver)).rejects.toThrow();
  });
});
