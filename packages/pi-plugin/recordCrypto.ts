/**
 * Ola Ink record-v1 decryption for the Pi extension.
 *
 * This module is deliberately self-contained so the published Pi package does
 * not depend on the relay's source tree. It implements the same P-256 ECDH,
 * HKDF-SHA-256, and AES-256-GCM record format as the relay.
 */

const VERSION = 1;
const CONTENT_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type DevicePublicKey = {
  deviceId: string;
  publicKeySpki: string;
};

export type DeviceKeyPair = DevicePublicKey & {
  privateKey: CryptoKey;
};

type EncryptedKeySlotV1 = {
  deviceId: string;
  ephemeralPublicKeySpki: string;
  wrapIv: string;
  wrappedContentKey: string;
};

export type EncryptedNoteRecordV1 = {
  version: 1;
  id: string;
  fromUserId: string;
  fromDeviceId: string;
  toUserId: string;
  toDirectoryVersion: number;
  contentIv: string;
  ciphertext: string;
  keySlots: EncryptedKeySlotV1[];
};

export type NotePayloadV1 = {
  filename: string;
  mime: string;
  note: Uint8Array;
  sha256: string;
};

function bytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function fromBase64Url(value: unknown, name: string): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error(`invalid ${name}`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error(`invalid ${name}`);
  return new Uint8Array(decoded);
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function contentAad(record: EncryptedNoteRecordV1): Uint8Array {
  return encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}`);
}

function slotAad(record: EncryptedNoteRecordV1, deviceId: string): Uint8Array {
  return encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}\0${deviceId}`);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validateRecord(record: unknown): EncryptedNoteRecordV1 {
  if (record === null || typeof record !== 'object') throw new Error('invalid encrypted note record');
  const value = record as Partial<EncryptedNoteRecordV1>;
  if (
    value.version !== VERSION || !validIdentifier(value.id) || !validIdentifier(value.fromUserId) ||
    !validIdentifier(value.fromDeviceId) || !validIdentifier(value.toUserId) ||
    !Number.isInteger(value.toDirectoryVersion) || (value.toDirectoryVersion ?? 0) < 1 ||
    !Array.isArray(value.keySlots) || value.keySlots.length < 1
  ) throw new Error('invalid encrypted note record');
  const contentIv = fromBase64Url(value.contentIv, 'content IV');
  const ciphertext = fromBase64Url(value.ciphertext, 'ciphertext');
  if (contentIv.byteLength !== GCM_IV_BYTES || ciphertext.byteLength < GCM_TAG_BYTES) {
    throw new Error('invalid encrypted note record');
  }
  for (const slot of value.keySlots) {
    if (slot === null || typeof slot !== 'object' || !validIdentifier(slot.deviceId)) throw new Error('invalid encrypted note record');
    if (fromBase64Url(slot.ephemeralPublicKeySpki, 'ephemeral public key').byteLength < 1 ||
      fromBase64Url(slot.wrapIv, 'wrap IV').byteLength !== GCM_IV_BYTES ||
      fromBase64Url(slot.wrappedContentKey, 'wrapped content key').byteLength < GCM_TAG_BYTES) {
      throw new Error('invalid encrypted note record');
    }
  }
  return value as EncryptedNoteRecordV1;
}

async function deriveWrapKey(privateKey: CryptoKey, publicKeySpki: string, record: EncryptedNoteRecordV1): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey(
    'spki', bytes(fromBase64Url(publicKeySpki, 'ephemeral public key')),
    { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bytes(new Uint8Array()), info: bytes(contentAad(record)) }, material,
    { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
}

/** Generates the long-lived P-256 device key that is registered during pairing. */
export async function generateDeviceKeyPair(deviceId: string): Promise<DeviceKeyPair> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKeySpki = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey)));
  return { deviceId, publicKeySpki, privateKey: keyPair.privateKey };
}

/** Decrypts and authenticates one record-v1 delivery for this device. */
export async function decryptNoteForDevice(input: unknown, device: DeviceKeyPair): Promise<NotePayloadV1> {
  const record = validateRecord(input);
  const slot = record.keySlots.find((candidate) => candidate.deviceId === device.deviceId);
  if (!slot) throw new Error('no key slot for this device');
  const wrapKey = await deriveWrapKey(device.privateKey, slot.ephemeralPublicKeySpki, record);
  const contentKey = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes(fromBase64Url(slot.wrapIv, 'wrap IV')), additionalData: bytes(slotAad(record, device.deviceId)) },
    wrapKey, bytes(fromBase64Url(slot.wrappedContentKey, 'wrapped content key')),
  ));
  if (contentKey.byteLength !== CONTENT_KEY_BYTES) throw new Error('invalid wrapped content key');
  const key = await crypto.subtle.importKey('raw', bytes(contentKey), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes(fromBase64Url(record.contentIv, 'content IV')), additionalData: bytes(contentAad(record)) },
    key, bytes(fromBase64Url(record.ciphertext, 'ciphertext')),
  );
  let payload: unknown;
  try { payload = JSON.parse(decoder.decode(plain)); } catch { throw new Error('invalid encrypted note payload'); }
  if (payload === null || typeof payload !== 'object') throw new Error('invalid encrypted note payload');
  const value = payload as Partial<NotePayloadV1> & { version?: unknown };
  if (
    value.version !== VERSION || typeof value.filename !== 'string' || value.filename.length < 1 || value.filename.length > 512 ||
    typeof value.mime !== 'string' || value.mime.length < 1 || value.mime.length > 128 ||
    typeof value.sha256 !== 'string'
  ) throw new Error('invalid encrypted note payload');
  const note = fromBase64Url(value.note, 'encrypted note bytes');
  const sha256 = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(note))));
  if (value.sha256 !== sha256) throw new Error('encrypted note hash mismatch');
  return { filename: value.filename, mime: value.mime, note, sha256 };
}
