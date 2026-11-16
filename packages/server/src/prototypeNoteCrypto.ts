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
import { MAX_NOTE_BYTES } from './limits.ts';

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
  /** Sender's Ola Ink address, carried inside the encrypted payload. */
  senderUsername?: string;
  /** Ask the v2 encoder to gzip the note before framing (hash covers the original). */
  encoding?: 'gzip';
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

/**
 * Record v2 (plans/binary-record-transport.md): the routing header travels
 * as small JSON while the ciphertext travels (and is stored) as raw bytes —
 * ~1:1 with the note instead of v1's base64-in-JSON 16:9. The crypto is
 * unchanged: same AAD, same key wrapping, only the framing differs.
 */
export interface EncryptedNoteHeaderV2 {
  version: 2;
  id: string;
  fromUserId: string;
  fromDeviceId: string;
  toUserId: string;
  toDirectoryVersion: number;
  contentIv: string;
  keySlots: EncryptedKeySlotV1[];
  /** Exact byte length of the blob (ciphertext || 16-byte GCM tag). */
  ciphertextBytes: number;
}

export interface EncryptedNoteV2 {
  header: EncryptedNoteHeaderV2;
  /** Raw AES-256-GCM ciphertext || tag; never base64-encoded on the wire. */
  blob: Uint8Array;
}

function fromB64(value: string, name: string): ByteArray {
  const bytes = fromBase64Url(value);
  if (bytes === null) throw new Error(`invalid ${name}`);
  return bytes;
}

function assertIv(value: ByteArray, name: string): void {
  if (value.length !== GCM_IV_BYTES) throw new Error(`invalid ${name}`);
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

async function decryptGcm(key: ByteArray, iv: ByteArray, ciphertextAndTag: Uint8Array, aad: ByteArray): Promise<ByteArray> {
  if (ciphertextAndTag.length < GCM_TAG_BYTES) throw new Error('ciphertext missing GCM tag');
  const aesKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  // Copy into a fresh ArrayBuffer-backed view: WebCrypto requires
  // ArrayBuffer-backed BufferSources.
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, new Uint8Array(ciphertextAndTag));
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

async function deriveWrapKey(
  privateKey: CryptoKey,
  publicKeySpki: string,
  record: Pick<EncryptedNoteRecordV1, 'id' | 'toUserId' | 'toDirectoryVersion'>,
): Promise<ByteArray> {
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

const PAYLOAD_VERSION_V2 = 2;
/** First byte of a v2 payload frame; a v1 payload is bare JSON and starts with '{' (0x7B). */
export const PAYLOAD_V2_TAG = 0x02;

/**
 * Encodes a payload as the v2 frame: tag byte, little-endian u32 header
 * length, a JSON header, then the (optionally gzipped) note as the rest of
 * the buffer — no base64 layer around the note. The header JSON's field
 * order (version, filename, mime, senderUsername?, encoding?, sha256) is
 * canonical so interop vectors can pin the plaintext byte-for-byte across
 * implementations.
 */
async function encodePayloadV2(payload: NotePayloadV1): Promise<ByteArray> {
  if (!payload.filename || payload.filename.length > 512) throw new Error('invalid filename');
  if (!payload.mime || payload.mime.length > 128) throw new Error('invalid MIME type');
  const noteHash = toBase64Url(await sha256(payload.note));
  if (payload.sha256 !== undefined && payload.sha256 !== noteHash) throw new Error('invalid note hash');
  const note = payload.encoding === 'gzip' ? await gzipBounded(payload.note) : payload.note;
  const header = utf8Encode(JSON.stringify({
    version: PAYLOAD_VERSION_V2,
    filename: payload.filename,
    mime: payload.mime,
    ...(payload.senderUsername ? { senderUsername: payload.senderUsername } : {}),
    ...(payload.encoding === 'gzip' ? { encoding: 'gzip' } : {}),
    sha256: noteHash,
  }));
  const out = new Uint8Array(5 + header.length + note.length);
  out[0] = PAYLOAD_V2_TAG;
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(1, header.length, true);
  out.set(header, 5);
  out.set(note, 5 + header.length);
  return out;
}

/** Deflates gzip with Web APIs only (Workers, Node, browsers). */
async function gzipBounded(bytes: Uint8Array): Promise<ByteArray> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
  }
  return concatBytes(...chunks);
}

/** Inflates gzip with a hard output cap, using only Web APIs (Workers, Node, browsers). */
async function gunzipBounded(bytes: Uint8Array, maxBytes: number): Promise<ByteArray> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('compressed note exceeds size limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error instanceof Error && error.message.includes('size limit') ? error : new Error('invalid compressed note');
  }
  return concatBytes(...chunks);
}

/** Decodes a decrypted payload in either format (v1 JSON or the v2 frame). */
export async function decodeNotePayload(plain: Uint8Array): Promise<NotePayloadV1> {
  // A v1 payload is bare JSON (first byte '{'); a v2 payload is the binary
  // frame. Anything else is invalid. `return await` (not `return`) so a
  // forged frame's synchronous rejection always has a handler attached —
  // a returned promise that rejects before any await reads as unhandled.
  if (plain.length > 0 && plain[0] === 0x7B) return await decodePayloadV1(plain);
  return await decodePayloadV2(plain);
}

async function decodePayloadV1(plain: Uint8Array): Promise<NotePayloadV1> {
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
  let note = fromB64(object.note as string, 'encrypted note bytes');
  // Optional payload compression: the note is gzipped before encryption and
  // the hash covers the original bytes.
  if (object.encoding === 'gzip') note = await gunzipBounded(note, MAX_NOTE_BYTES);
  else if (object.encoding !== undefined) throw new Error('unsupported note encoding');
  const storedHash = object.sha256 as string;
  const expectedHash = toBase64Url(await sha256(note));
  if (storedHash !== expectedHash) throw new Error('encrypted note hash mismatch');
  return {
    filename: object.filename as string,
    mime: object.mime as string,
    note,
    sha256: storedHash,
    ...(typeof object.senderUsername === 'string' ? { senderUsername: object.senderUsername } : {}),
  };
}

/** The v2 frame's entire hand-rolled surface: one tag byte, one u32 length. */
async function decodePayloadV2(plain: Uint8Array): Promise<NotePayloadV1> {
  if (plain.length < 5 || plain[0] !== PAYLOAD_V2_TAG) throw new Error('invalid encrypted note payload');
  const headerLength = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(1, true);
  if (headerLength < 2 || 5 + headerLength > plain.length) throw new Error('invalid encrypted note payload');
  let parsed: unknown;
  try { parsed = JSON.parse(utf8Decode(plain.subarray(5, 5 + headerLength))); } catch {
    throw new Error('invalid encrypted note payload');
  }
  if (
    parsed === null || typeof parsed !== 'object' ||
    (parsed as Record<string, unknown>).version !== PAYLOAD_VERSION_V2 ||
    typeof (parsed as Record<string, unknown>).filename !== 'string' ||
    typeof (parsed as Record<string, unknown>).mime !== 'string' ||
    typeof (parsed as Record<string, unknown>).sha256 !== 'string'
  ) throw new Error('invalid encrypted note payload');
  const object = parsed as Record<string, unknown>;
  if (typeof object.filename !== 'string' || object.filename.length > 512 ||
      typeof object.mime !== 'string' || object.mime.length > 128 ||
      (object.senderUsername !== undefined && typeof object.senderUsername !== 'string')) {
    throw new Error('invalid encrypted note payload');
  }
  // The note is the rest of the AES plaintext: GCM authenticates its exact
  // length, so the frame needs no note length field.
  let note = plain.subarray(5 + headerLength);
  if (object.encoding === 'gzip') note = await gunzipBounded(note, MAX_NOTE_BYTES);
  else if (object.encoding !== undefined) throw new Error('unsupported note encoding');
  const storedHash = object.sha256 as string;
  const expectedHash = toBase64Url(await sha256(note));
  if (storedHash !== expectedHash) throw new Error('encrypted note hash mismatch');
  return {
    filename: object.filename as string,
    mime: object.mime as string,
    note,
    sha256: storedHash,
    ...(typeof object.senderUsername === 'string' ? { senderUsername: object.senderUsername } : {}),
  };
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
  record.keySlots = await wrapContentKey(record, contentKey, options.recipients);
  return record;
}

/** Wraps one content key per recipient; identical for record v1 and v2. */
async function wrapContentKey(
  record: Pick<EncryptedNoteRecordV1, 'id' | 'toUserId' | 'toDirectoryVersion'>,
  contentKey: ByteArray,
  recipients: DevicePublicKey[],
): Promise<EncryptedKeySlotV1[]> {
  const slots: EncryptedKeySlotV1[] = [];
  for (const recipient of recipients) {
    await assertPublicKey(recipient.publicKeySpki);
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const recipientPublic = await importEcdhPublicKey(recipient.publicKeySpki, 'recipient public key');
    const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipientPublic }, ephemeral.privateKey, 256);
    const wrapKey = await hkdfSha256(new Uint8Array(secret), contentAad(record), CONTENT_KEY_BYTES);
    const wrapIv = randomBytes(GCM_IV_BYTES);
    const spki = await crypto.subtle.exportKey('spki', ephemeral.publicKey);
    slots.push({
      deviceId: recipient.deviceId,
      ephemeralPublicKeySpki: toBase64Url(new Uint8Array(spki)),
      wrapIv: toBase64Url(wrapIv),
      wrappedContentKey: toBase64Url(await encryptGcm(wrapKey, wrapIv, contentKey, slotAad(record, recipient.deviceId))),
    });
  }
  return slots;
}

/** Record-v2 sender: same construction as v1, framed as header + raw blob. */
export async function encryptNoteForDevicesV2(
  payload: NotePayloadV1,
  options: {
    fromUserId: string;
    fromDeviceId: string;
    toUserId: string;
    toDirectoryVersion: number;
    recipients: DevicePublicKey[];
  },
): Promise<EncryptedNoteV2> {
  if (!options.fromUserId || !options.fromDeviceId || !options.toUserId || !Number.isInteger(options.toDirectoryVersion) || options.toDirectoryVersion < 1) {
    throw new Error('invalid note routing');
  }
  if (options.recipients.length === 0 || new Set(options.recipients.map((device) => device.deviceId)).size !== options.recipients.length) {
    throw new Error('recipient slots must be non-empty and unique');
  }

  const header: EncryptedNoteHeaderV2 = {
    version: 2,
    id: crypto.randomUUID(),
    fromUserId: options.fromUserId,
    fromDeviceId: options.fromDeviceId,
    toUserId: options.toUserId,
    toDirectoryVersion: options.toDirectoryVersion,
    contentIv: toBase64Url(randomBytes(GCM_IV_BYTES)),
    keySlots: [],
    ciphertextBytes: 0,
  };
  const contentKey = randomBytes(CONTENT_KEY_BYTES);
  const blob = await encryptGcm(contentKey, fromB64(header.contentIv, 'content IV'), await encodePayloadV2(payload), contentAad(header));
  header.ciphertextBytes = blob.length;
  header.keySlots = await wrapContentKey(header, contentKey, options.recipients);
  return { header, blob };
}

/** The routing fields the decryption path reads; satisfied by v1 records and v2 headers alike. */
export type RecordRouting = Pick<EncryptedNoteRecordV1, 'id' | 'toUserId' | 'toDirectoryVersion' | 'contentIv'> & {
  keySlots: EncryptedKeySlotV1[];
};

/** Decrypts the plaintext (either payload format) shared by v1 and v2 records. */
async function unwrapAndDecrypt(
  record: RecordRouting,
  ciphertext: Uint8Array,
  device: DeviceKeyPair,
): Promise<NotePayloadV1> {
  const slot = record.keySlots.find((candidate) => candidate.deviceId === device.deviceId);
  if (!slot) throw new Error('no key slot for device');
  const wrapIv = fromB64(slot.wrapIv, 'wrap IV');
  const contentIv = fromB64(record.contentIv, 'content IV');
  assertIv(wrapIv, 'wrap IV');
  assertIv(contentIv, 'content IV');
  const wrapKey = await deriveWrapKey(device.privateKey, slot.ephemeralPublicKeySpki, record);
  const contentKey = await decryptGcm(wrapKey, wrapIv, fromB64(slot.wrappedContentKey, 'wrapped content key'), slotAad(record, device.deviceId));
  if (contentKey.length !== CONTENT_KEY_BYTES) throw new Error('invalid unwrapped content key');
  return await decodeNotePayload(await decryptGcm(contentKey, contentIv, ciphertext, contentAad(record)));
}

export async function decryptNoteForDevice(record: EncryptedNoteRecordV1, device: DeviceKeyPair): Promise<NotePayloadV1> {
  return unwrapAndDecrypt(record, fromB64(record.ciphertext, 'ciphertext'), device);
}

/** Decrypts a record-v2 header + blob (and, structurally, any legacy v1 record handed in as one). */
export async function decryptNoteForDeviceV2(record: RecordRouting, blob: Uint8Array, device: DeviceKeyPair): Promise<NotePayloadV1> {
  return unwrapAndDecrypt(record, blob, device);
}
