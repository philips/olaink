/**
 * Reference E2E crypto for the encrypted-note record, in WebCrypto.
 *
 * This module is the wire-format reference for v1: the PWA implements the
 * same construction, and `webCryptoInterop.test.ts` decrypts records with an
 * independent WebCrypto implementation so vectors catch contract drift. It
 * runs unmodified in the Worker, the standalone binary, and the Vitest
 * suites. The relay only inspects routing fields, slot shape, and the
 * public-key curve; payloads stay opaque to the service.
 *
 * Wire layout is unchanged from the legacy Node implementation:
 * P-256 ECDH + HKDF-SHA-256 (empty salt, content AAD as info) + AES-256-GCM,
 * with each GCM blob stored as ciphertext || 16-byte auth tag and every
 * binary field encoded as canonical unpadded base64url.
 */

import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode, type ByteArray } from './bytes.ts';

const VERSION = 1;
const GCM_TAG_BYTES = 16;
const GCM_IV_BYTES = 12;
const CONTENT_KEY_BYTES = 32;

export interface DevicePublicKey {
  deviceId: string;
  publicKeySpki: string;
}

export interface DeviceKeyPair extends DevicePublicKey {
  privateKey: CryptoKey;
}

export interface NotePayloadV1 {
  filename: string;
  mime: string;
  note: Uint8Array;
  /** SHA-256 of note bytes, encrypted alongside the metadata and body. */
  sha256?: string;
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

function fromB64(value: string, name: string): ByteArray {
  const bytes = fromBase64Url(value);
  if (bytes === null) throw new Error(`invalid ${name}`);
  return bytes;
}

function assertIv(value: ByteArray, name: string): void {
  if (value.length !== GCM_IV_BYTES) throw new Error(`invalid ${name}`);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function concatBytes(...arrays: Uint8Array[]): ByteArray {
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

function contentAad(record: Pick<EncryptedNoteRecordV1, 'id' | 'toUserId' | 'toDirectoryVersion'>): ByteArray {
  return utf8Encode(`olaink.note.v1\u0000${record.id}\u0000${record.toUserId}\u0000${record.toDirectoryVersion}`);
}

function slotAad(record: Pick<EncryptedNoteRecordV1, 'id' | 'toUserId' | 'toDirectoryVersion'>, deviceId: string): ByteArray {
  return concatBytes(contentAad(record), utf8Encode(`\u0000${deviceId}`));
}

function randomBytes(length: number): ByteArray {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<ByteArray> {
  // Copy into a fresh ArrayBuffer-backed view: WebCrypto requires
  // ArrayBuffer-backed BufferSources.
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}

async function encryptGcm(key: ByteArray, iv: ByteArray, plain: ByteArray, aad: ByteArray): Promise<ByteArray> {
  const aesKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  // WebCrypto GCM output is ciphertext || 16-byte tag — the wire layout the
  // record format has always used.
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, plain);
  return new Uint8Array(sealed);
}

async function decryptGcm(key: ByteArray, iv: ByteArray, ciphertextAndTag: ByteArray, aad: ByteArray): Promise<ByteArray> {
  if (ciphertextAndTag.length < GCM_TAG_BYTES) throw new Error('ciphertext missing GCM tag');
  const aesKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, ciphertextAndTag);
  return new Uint8Array(plain);
}

async function hkdfSha256(ikm: ByteArray, info: ByteArray, length: number): Promise<ByteArray> {
  const hkdfKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF', hash: 'SHA-256' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    hkdfKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

function importEcdhPublicKey(publicKeySpki: string, name: string): Promise<CryptoKey> {
  // importKey validates both the SPKI DER and that the named curve is P-256;
  // any other shape rejects here. Per WebCrypto, ECDH public keys take an
  // empty usages list (they are only used as the deriveBits peer), matching
  // the PWA's import.
  return crypto.subtle.importKey('spki', fromB64(publicKeySpki, name), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

export async function assertPublicKey(publicKeySpki: string): Promise<void> {
  try {
    await importEcdhPublicKey(publicKeySpki, 'public key');
  } catch {
    throw new Error('public key is not P-256');
  }
}

/**
 * Pure synchronous SPKI shape check for the legacy sync stack, which cannot
 * await WebCrypto. Accepts exactly well-formed P-256 uncompressed SPKI DER;
 * the async `assertPublicKey` additionally gets full WebCrypto validation
 * (including on-curve checking).
 */
const EC_PUBLIC_KEY_OID = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
const P256_OID = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);

export function assertPublicKeySync(publicKeySpki: string): void {
  const spki = fromB64(publicKeySpki, 'public key');
  if (
    spki.length !== 91 ||
    spki[0] !== 0x30 || spki[1] !== 0x59 ||
    spki[2] !== 0x30 || spki[3] !== 0x13 ||
    spki[4] !== 0x06 || spki[5] !== 0x07 || !bytesEqual(spki.subarray(6, 13), EC_PUBLIC_KEY_OID) ||
    spki[13] !== 0x06 || spki[14] !== 0x08 || !bytesEqual(spki.subarray(15, 23), P256_OID) ||
    spki[23] !== 0x03 || spki[24] !== 0x42 || spki[25] !== 0x00 || spki[26] !== 0x04
  ) {
    throw new Error('public key is not P-256');
  }
}

async function deriveWrapKey(privateKey: CryptoKey, publicKeySpki: string, record: EncryptedNoteRecordV1): Promise<ByteArray> {
  const peer = await importEcdhPublicKey(publicKeySpki, 'ephemeral public key');
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  return hkdfSha256(new Uint8Array(secret), contentAad(record), CONTENT_KEY_BYTES);
}

async function encodePayload(payload: NotePayloadV1): Promise<ByteArray> {
  if (!payload.filename || payload.filename.length > 512) throw new Error('invalid filename');
  if (!payload.mime || payload.mime.length > 128) throw new Error('invalid MIME type');
  const noteHash = toBase64Url(await sha256(payload.note));
  if (payload.sha256 !== undefined && payload.sha256 !== noteHash) throw new Error('invalid note hash');
  return utf8Encode(JSON.stringify({
    version: VERSION,
    filename: payload.filename,
    mime: payload.mime,
    note: toBase64Url(payload.note),
    sha256: noteHash,
  }));
}

async function decodePayload(plain: Uint8Array): Promise<NotePayloadV1> {
  let parsed: unknown;
  try { parsed = JSON.parse(utf8Decode(plain)); } catch { throw new Error('invalid encrypted note payload'); }
  if (
    parsed === null || typeof parsed !== 'object' ||
    (parsed as Record<string, unknown>).version !== VERSION ||
    typeof (parsed as Record<string, unknown>).filename !== 'string' ||
    typeof (parsed as Record<string, unknown>).mime !== 'string' ||
    typeof (parsed as Record<string, unknown>).note !== 'string' ||
    typeof (parsed as Record<string, unknown>).sha256 !== 'string'
  ) throw new Error('invalid encrypted note payload');
  const object = parsed as Record<string, unknown>;
  const note = fromB64(object.note as string, 'encrypted note bytes');
  const storedHash = object.sha256 as string;
  const expectedHash = toBase64Url(await sha256(note));
  if (storedHash !== expectedHash) throw new Error('encrypted note hash mismatch');
  return { filename: object.filename as string, mime: object.mime as string, note, sha256: storedHash };
}

export async function generateDeviceKeyPair(deviceId: string): Promise<DeviceKeyPair> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  return { deviceId, privateKey: keyPair.privateKey, publicKeySpki: toBase64Url(new Uint8Array(spki)) };
}

export async function encryptNoteForDevices(
  payload: NotePayloadV1,
  options: {
    fromUserId: string;
    fromDeviceId: string;
    toUserId: string;
    toDirectoryVersion: number;
    recipients: DevicePublicKey[];
  },
): Promise<EncryptedNoteRecordV1> {
  if (!options.fromUserId || !options.fromDeviceId || !options.toUserId || !Number.isInteger(options.toDirectoryVersion) || options.toDirectoryVersion < 1) {
    throw new Error('invalid note routing');
  }
  if (options.recipients.length === 0 || new Set(options.recipients.map((device) => device.deviceId)).size !== options.recipients.length) {
    throw new Error('recipient slots must be non-empty and unique');
  }

  const record: EncryptedNoteRecordV1 = {
    version: VERSION,
    id: crypto.randomUUID(),
    fromUserId: options.fromUserId,
    fromDeviceId: options.fromDeviceId,
    toUserId: options.toUserId,
    toDirectoryVersion: options.toDirectoryVersion,
    contentIv: toBase64Url(randomBytes(GCM_IV_BYTES)),
    ciphertext: '',
    keySlots: [],
  };
  const contentKey = randomBytes(CONTENT_KEY_BYTES);
  record.ciphertext = toBase64Url(
    await encryptGcm(contentKey, fromB64(record.contentIv, 'content IV'), await encodePayload(payload), contentAad(record)),
  );

  for (const recipient of options.recipients) {
    await assertPublicKey(recipient.publicKeySpki);
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const recipientPublic = await importEcdhPublicKey(recipient.publicKeySpki, 'recipient public key');
    const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipientPublic }, ephemeral.privateKey, 256);
    const wrapKey = await hkdfSha256(new Uint8Array(secret), contentAad(record), CONTENT_KEY_BYTES);
    const wrapIv = randomBytes(GCM_IV_BYTES);
    const spki = await crypto.subtle.exportKey('spki', ephemeral.publicKey);
    record.keySlots.push({
      deviceId: recipient.deviceId,
      ephemeralPublicKeySpki: toBase64Url(new Uint8Array(spki)),
      wrapIv: toBase64Url(wrapIv),
      wrappedContentKey: toBase64Url(await encryptGcm(wrapKey, wrapIv, contentKey, slotAad(record, recipient.deviceId))),
    });
  }
  return record;
}

export async function decryptNoteForDevice(record: EncryptedNoteRecordV1, device: DeviceKeyPair): Promise<NotePayloadV1> {
  const slot = record.keySlots.find((candidate) => candidate.deviceId === device.deviceId);
  if (!slot) throw new Error('no key slot for device');
  const wrapIv = fromB64(slot.wrapIv, 'wrap IV');
  const contentIv = fromB64(record.contentIv, 'content IV');
  assertIv(wrapIv, 'wrap IV');
  assertIv(contentIv, 'content IV');
  const wrapKey = await deriveWrapKey(device.privateKey, slot.ephemeralPublicKeySpki, record);
  const contentKey = await decryptGcm(wrapKey, wrapIv, fromB64(slot.wrappedContentKey, 'wrapped content key'), slotAad(record, device.deviceId));
  if (contentKey.length !== CONTENT_KEY_BYTES) throw new Error('invalid unwrapped content key');
  return decodePayload(await decryptGcm(contentKey, contentIv, fromB64(record.ciphertext, 'ciphertext'), contentAad(record)));
}
