/**
 * Node-only crypto used by the encrypted-note prototype and its echo device.
 *
 * The production PWA must implement this exact wire format with WebCrypto and
 * independent vectors before this becomes a product protocol. The relay only
 * handles EncryptedNoteRecordV1; this module is deliberately used by the
 * server-resident test echo device, never by normal routing.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from 'node:crypto';

const VERSION = 1;
const GCM_TAG_BYTES = 16;
const GCM_IV_BYTES = 12;
const CONTENT_KEY_BYTES = 32;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface DevicePublicKey {
  deviceId: string;
  publicKeySpki: string;
}

export interface DeviceKeyPair extends DevicePublicKey {
  privateKey: KeyObject;
}

export interface NotePayloadV1 {
  filename: string;
  mime: string;
  note: Buffer;
}

export interface EncryptedKeySlotV1 {
  deviceId: string;
  ephemeralPublicKeySpki: string;
  wrapIv: string;
  wrappedContentKey: string;
}

/** Opaque to the relay except for routing, recipient slots, and size. */
export interface EncryptedNoteRecordV1 {
  version: 1;
  id: string;
  fromUserId: string;
  fromDeviceId: string;
  toUserId: string;
  toDirectoryVersion: number;
  contentIv: string;
  ciphertext: string;
  keySlots: EncryptedKeySlotV1[];
}

function toB64(data: Buffer): string { return data.toString('base64url'); }

function fromB64(value: string, name: string): Buffer {
  if (!B64URL.test(value)) throw new Error(`invalid ${name}`);
  return Buffer.from(value, 'base64url');
}

function assertIv(value: Buffer, name: string): void {
  if (value.length !== GCM_IV_BYTES) throw new Error(`invalid ${name}`);
}

function contentAad(record: Pick<EncryptedNoteRecordV1, 'id' | 'toUserId' | 'toDirectoryVersion'>): Buffer {
  return Buffer.from(`olaink.note.v1\u0000${record.id}\u0000${record.toUserId}\u0000${record.toDirectoryVersion}`);
}

function slotAad(record: Pick<EncryptedNoteRecordV1, 'id' | 'toUserId' | 'toDirectoryVersion'>, deviceId: string): Buffer {
  return Buffer.concat([contentAad(record), Buffer.from(`\u0000${deviceId}`)]);
}

function encryptGcm(key: Buffer, iv: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function decryptGcm(key: Buffer, iv: Buffer, ciphertextAndTag: Buffer, aad: Buffer): Buffer {
  if (ciphertextAndTag.length < GCM_TAG_BYTES) throw new Error('ciphertext missing GCM tag');
  const ciphertext = ciphertextAndTag.subarray(0, -GCM_TAG_BYTES);
  const tag = ciphertextAndTag.subarray(-GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function deriveWrapKey(privateKey: KeyObject, publicKeySpki: string, record: EncryptedNoteRecordV1): Buffer {
  const peer = createPublicKey({ key: fromB64(publicKeySpki, 'ephemeral public key'), format: 'der', type: 'spki' });
  const secret = diffieHellman({ privateKey, publicKey: peer });
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), contentAad(record), CONTENT_KEY_BYTES));
}

function encodePayload(payload: NotePayloadV1): Buffer {
  if (!payload.filename || payload.filename.length > 512) throw new Error('invalid filename');
  if (!payload.mime || payload.mime.length > 128) throw new Error('invalid MIME type');
  return Buffer.from(JSON.stringify({
    version: VERSION,
    filename: payload.filename,
    mime: payload.mime,
    note: toB64(payload.note),
  }));
}

function decodePayload(plain: Buffer): NotePayloadV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(plain.toString('utf8')); } catch { throw new Error('invalid encrypted note payload'); }
  if (
    parsed === null || typeof parsed !== 'object' ||
    (parsed as Record<string, unknown>).version !== VERSION ||
    typeof (parsed as Record<string, unknown>).filename !== 'string' ||
    typeof (parsed as Record<string, unknown>).mime !== 'string' ||
    typeof (parsed as Record<string, unknown>).note !== 'string'
  ) throw new Error('invalid encrypted note payload');
  const object = parsed as Record<string, unknown>;
  return {
    filename: object.filename as string,
    mime: object.mime as string,
    note: fromB64(object.note as string, 'encrypted note bytes'),
  };
}

export function generateDeviceKeyPair(deviceId: string): DeviceKeyPair {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return makeDeviceKeyPair(deviceId, keys.privateKey);
}

/** Restore the server-resident echo test key from a PEM value in SQLite. */
export function deviceKeyPairFromPrivateKey(deviceId: string, privateKeyPem: string): DeviceKeyPair {
  return makeDeviceKeyPair(deviceId, createPrivateKey(privateKeyPem));
}

function makeDeviceKeyPair(deviceId: string, privateKey: KeyObject): DeviceKeyPair {
  return {
    deviceId,
    privateKey,
    publicKeySpki: toB64(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer),
  };
}

export function exportPrivateKeyPem(device: DeviceKeyPair): string {
  return device.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

export function assertPublicKey(publicKeySpki: string): void {
  const publicKey = createPublicKey({ key: fromB64(publicKeySpki, 'public key'), format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('public key is not P-256');
  }
}

export function encryptNoteForDevices(
  payload: NotePayloadV1,
  options: {
    fromUserId: string;
    fromDeviceId: string;
    toUserId: string;
    toDirectoryVersion: number;
    recipients: DevicePublicKey[];
  },
): EncryptedNoteRecordV1 {
  if (!options.fromUserId || !options.fromDeviceId || !options.toUserId || !Number.isInteger(options.toDirectoryVersion) || options.toDirectoryVersion < 1) {
    throw new Error('invalid note routing');
  }
  if (options.recipients.length === 0 || new Set(options.recipients.map((device) => device.deviceId)).size !== options.recipients.length) {
    throw new Error('recipient slots must be non-empty and unique');
  }

  const record: EncryptedNoteRecordV1 = {
    version: VERSION,
    id: randomUUID(),
    fromUserId: options.fromUserId,
    fromDeviceId: options.fromDeviceId,
    toUserId: options.toUserId,
    toDirectoryVersion: options.toDirectoryVersion,
    contentIv: toB64(randomBytes(GCM_IV_BYTES)),
    ciphertext: '',
    keySlots: [],
  };
  const contentKey = randomBytes(CONTENT_KEY_BYTES);
  const iv = fromB64(record.contentIv, 'content IV');
  record.ciphertext = toB64(encryptGcm(contentKey, iv, encodePayload(payload), contentAad(record)));

  for (const recipient of options.recipients) {
    assertPublicKey(recipient.publicKeySpki);
    const ephemeral = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const recipientPublic = createPublicKey({ key: fromB64(recipient.publicKeySpki, 'recipient public key'), format: 'der', type: 'spki' });
    const secret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPublic });
    const wrapKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), contentAad(record), CONTENT_KEY_BYTES));
    const wrapIv = randomBytes(GCM_IV_BYTES);
    record.keySlots.push({
      deviceId: recipient.deviceId,
      ephemeralPublicKeySpki: toB64(ephemeral.publicKey.export({ format: 'der', type: 'spki' }) as Buffer),
      wrapIv: toB64(wrapIv),
      wrappedContentKey: toB64(encryptGcm(wrapKey, wrapIv, contentKey, slotAad(record, recipient.deviceId))),
    });
  }
  return record;
}

export function decryptNoteForDevice(record: EncryptedNoteRecordV1, device: DeviceKeyPair): NotePayloadV1 {
  const slot = record.keySlots.find((candidate) => candidate.deviceId === device.deviceId);
  if (!slot) throw new Error('no key slot for device');
  const wrapIv = fromB64(slot.wrapIv, 'wrap IV');
  const contentIv = fromB64(record.contentIv, 'content IV');
  assertIv(wrapIv, 'wrap IV');
  assertIv(contentIv, 'content IV');
  const wrapKey = deriveWrapKey(device.privateKey, slot.ephemeralPublicKeySpki, record);
  const contentKey = decryptGcm(wrapKey, wrapIv, fromB64(slot.wrappedContentKey, 'wrapped content key'), slotAad(record, device.deviceId));
  if (contentKey.length !== CONTENT_KEY_BYTES) throw new Error('invalid unwrapped content key');
  return decodePayload(decryptGcm(contentKey, contentIv, fromB64(record.ciphertext, 'ciphertext'), contentAad(record)));
}
