/**
 * Ola Ink record-v1 encryption and decryption for the Pi extension.
 *
 * This module is deliberately self-contained so the published Pi package does
 * not depend on the relay's source tree. It implements the same P-256 ECDH,
 * HKDF-SHA-256, and AES-256-GCM record format as the relay.
 */

import { gunzipSync, gzipSync } from 'node:zlib';

const VERSION = 1;
/**
 * Device-memory inflation ceiling (decompression-bomb guard). NOT the
 * product limit — the relay enforces that — so this stays a generous fixed
 * bound and the service can raise its limit without republishing this
 * package.
 */
const MAX_INFLATED_NOTE_BYTES = 128 * 1024 * 1024;
const CONTENT_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
/** First byte of a v2 payload frame; a v1 payload is bare JSON and starts with '{'. */
const PAYLOAD_V2_TAG = 0x02;
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

/** The routing fields the AAD covers; satisfied by v1 records and v2 headers alike. */
type RecordRouting = Pick<EncryptedNoteRecordV1, 'id' | 'toUserId' | 'toDirectoryVersion'>;

function contentAad(record: RecordRouting): Uint8Array {
  return encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}`);
}

function slotAad(record: RecordRouting, deviceId: string): Uint8Array {
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

/** Structural check of a v2 routing header plus its raw ciphertext blob. */
function validateHeaderV2(input: unknown, blob: Uint8Array | undefined): EncryptedNoteHeaderV2 {
  if (input === null || typeof input !== 'object') throw new Error('invalid encrypted note record');
  const value = input as Partial<EncryptedNoteHeaderV2>;
  if (
    value.version !== 2 || !validIdentifier(value.id) || !validIdentifier(value.fromUserId) ||
    !validIdentifier(value.fromDeviceId) || !validIdentifier(value.toUserId) ||
    !Number.isInteger(value.toDirectoryVersion) || (value.toDirectoryVersion ?? 0) < 1 ||
    !Array.isArray(value.keySlots) || value.keySlots.length < 1 ||
    !Number.isInteger(value.ciphertextBytes) || (value.ciphertextBytes ?? 0) < GCM_TAG_BYTES ||
    !(blob instanceof Uint8Array) || blob.byteLength !== value.ciphertextBytes
  ) throw new Error('invalid encrypted note record');
  if (fromBase64Url(value.contentIv, 'content IV').byteLength !== GCM_IV_BYTES) {
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
  return value as EncryptedNoteHeaderV2;
}

/** A recipient account's current device directory, as the relay reports it. */
export type DeviceDirectory = {
  userId: string;
  version: number;
  devices: (DevicePublicKey & { payloadVersions?: number[] })[];
};

/**
 * The highest payload version in the intersection of what every directory
 * device advertises; 1 when any device is legacy (v1 is the universal
 * baseline every decoder accepts).
 */
export function negotiatedPayloadVersion(directory: DeviceDirectory): number {
  let candidates: number[] | null = null;
  for (const device of directory.devices) {
    const supported = device.payloadVersions && device.payloadVersions.length > 0 ? device.payloadVersions : [1];
    candidates = candidates === null ? [...supported] : candidates.filter((version) => supported.includes(version));
  }
  return candidates !== null && candidates.length > 0 ? Math.max(...candidates) : 1;
}

/** Record v2 (plans/binary-record-transport.md): routing header + raw ciphertext blob. */
export type EncryptedNoteHeaderV2 = {
  version: 2;
  id: string;
  fromUserId: string;
  fromDeviceId: string;
  toUserId: string;
  toDirectoryVersion: number;
  contentIv: string;
  keySlots: EncryptedKeySlotV1[];
  ciphertextBytes: number;
};

export type EncryptedNoteV2 = { header: EncryptedNoteHeaderV2; blob: Uint8Array };

async function deriveWrapKey(
  privateKey: CryptoKey, publicKeySpki: string, record: RecordRouting, usage: 'encrypt' | 'decrypt' = 'decrypt',
): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey(
    'spki', bytes(fromBase64Url(publicKeySpki, 'ephemeral public key')),
    { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bytes(new Uint8Array()), info: bytes(contentAad(record)) }, material,
    { name: 'AES-GCM', length: 256 }, false, [usage],
  );
}

/**
 * Encrypts one whole note to every device in the recipient's directory. The
 * relay rejects a record unless it has exactly one slot per directory device
 * and names the directory version it was encrypted against.
 */
export async function encryptNoteForDevices(
  payload: { filename: string; mime: string; note: Uint8Array; senderUsername?: string },
  // Gzip the note inside the encrypted payload ("encoding":"gzip"). Text-box
  // replies shrink about 4x. The hash always covers the original bytes.
  options: { fromUserId: string; fromDeviceId: string; directory: DeviceDirectory; compress?: boolean },
): Promise<EncryptedNoteRecordV1> {
  const { directory } = options;
  if (payload.filename.length < 1 || payload.filename.length > 512) throw new Error('invalid filename');
  if (directory.devices.length === 0) throw new Error('recipient has no devices');
  if (new Set(directory.devices.map((device) => device.deviceId)).size !== directory.devices.length) {
    throw new Error('recipient directory has duplicate devices');
  }
  const record: EncryptedNoteRecordV1 = {
    version: VERSION,
    id: crypto.randomUUID(),
    fromUserId: options.fromUserId,
    fromDeviceId: options.fromDeviceId,
    toUserId: directory.userId,
    toDirectoryVersion: directory.version,
    contentIv: toBase64Url(crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES))),
    ciphertext: '',
    keySlots: [],
  };
  const sha256 = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(payload.note))));
  const compress = options.compress ?? true;
  const plain = encoder.encode(JSON.stringify({
    version: VERSION, filename: payload.filename, mime: payload.mime,
    ...(compress ? { encoding: 'gzip' } : {}),
    note: toBase64Url(compress ? new Uint8Array(gzipSync(payload.note, { level: 9 })) : payload.note), sha256,
    // Display-only: the Supernote plugin names saved notes after it.
    ...(payload.senderUsername ? { senderUsername: payload.senderUsername } : {}),
  }));
  const contentKey = crypto.getRandomValues(new Uint8Array(CONTENT_KEY_BYTES));
  const key = await crypto.subtle.importKey('raw', bytes(contentKey), 'AES-GCM', false, ['encrypt']);
  record.ciphertext = toBase64Url(new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bytes(fromBase64Url(record.contentIv, 'content IV')), additionalData: bytes(contentAad(record)) },
    key, bytes(plain),
  )));
  for (const recipient of directory.devices) {
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const wrapKey = await deriveWrapKey(ephemeral.privateKey, recipient.publicKeySpki, record, 'encrypt');
    const wrapIv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
    const wrapped = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytes(wrapIv), additionalData: bytes(slotAad(record, recipient.deviceId)) },
      wrapKey, bytes(contentKey),
    );
    record.keySlots.push({
      deviceId: recipient.deviceId,
      ephemeralPublicKeySpki: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', ephemeral.publicKey))),
      wrapIv: toBase64Url(wrapIv),
      wrappedContentKey: toBase64Url(new Uint8Array(wrapped)),
    });
  }
  return record;
}

/**
 * Record-v2 sender: the same P-256/HKDF/AES-GCM construction as v1, framed
 * as a small JSON routing header plus the ciphertext as raw bytes. The
 * payload inside the encryption is the v2 frame — a length-prefixed JSON
 * header with the (optionally gzipped) note as trailing bytes, so the note
 * never pays the base64 tax.
 */
export async function encryptNoteForDevicesV2(
  payload: { filename: string; mime: string; note: Uint8Array; senderUsername?: string },
  options: { fromUserId: string; fromDeviceId: string; directory: DeviceDirectory; compress?: boolean },
): Promise<EncryptedNoteV2> {
  const { directory } = options;
  if (payload.filename.length < 1 || payload.filename.length > 512) throw new Error('invalid filename');
  if (directory.devices.length === 0) throw new Error('recipient has no devices');
  if (new Set(directory.devices.map((device) => device.deviceId)).size !== directory.devices.length) {
    throw new Error('recipient directory has duplicate devices');
  }
  const header: EncryptedNoteHeaderV2 = {
    version: 2,
    id: crypto.randomUUID(),
    fromUserId: options.fromUserId,
    fromDeviceId: options.fromDeviceId,
    toUserId: directory.userId,
    toDirectoryVersion: directory.version,
    contentIv: toBase64Url(crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES))),
    keySlots: [],
    ciphertextBytes: 0,
  };
  const sha256 = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(payload.note))));
  const compress = options.compress ?? true;
  const carried = compress ? new Uint8Array(gzipSync(payload.note, { level: 9 })) : payload.note;
  // Field order is canonical (version, filename, mime, senderUsername,
  // encoding, sha256) so interop vectors can pin the plaintext byte-for-byte.
  const payloadHeader = encoder.encode(JSON.stringify({
    version: 2, filename: payload.filename, mime: payload.mime,
    ...(payload.senderUsername ? { senderUsername: payload.senderUsername } : {}),
    ...(compress ? { encoding: 'gzip' } : {}), sha256,
  }));
  const plain = new Uint8Array(5 + payloadHeader.length + carried.length);
  plain[0] = PAYLOAD_V2_TAG;
  new DataView(plain.buffer).setUint32(1, payloadHeader.length, true);
  plain.set(payloadHeader, 5);
  plain.set(carried, 5 + payloadHeader.length);
  const contentKey = crypto.getRandomValues(new Uint8Array(CONTENT_KEY_BYTES));
  const key = await crypto.subtle.importKey('raw', bytes(contentKey), 'AES-GCM', false, ['encrypt']);
  const blob = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bytes(fromBase64Url(header.contentIv, 'content IV')), additionalData: bytes(contentAad(header)) },
    key, bytes(plain),
  ));
  header.ciphertextBytes = blob.byteLength;
  for (const recipient of directory.devices) {
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const wrapKey = await deriveWrapKey(ephemeral.privateKey, recipient.publicKeySpki, header, 'encrypt');
    const wrapIv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
    const wrapped = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytes(wrapIv), additionalData: bytes(slotAad(header, recipient.deviceId)) },
      wrapKey, bytes(contentKey),
    );
    header.keySlots.push({
      deviceId: recipient.deviceId,
      ephemeralPublicKeySpki: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', ephemeral.publicKey))),
      wrapIv: toBase64Url(wrapIv),
      wrappedContentKey: toBase64Url(new Uint8Array(wrapped)),
    });
  }
  return { header, blob };
}

/** Generates the long-lived P-256 device key that is registered during pairing. */
export async function generateDeviceKeyPair(deviceId: string): Promise<DeviceKeyPair> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKeySpki = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey)));
  return { deviceId, publicKeySpki, privateKey: keyPair.privateKey };
}

/**
 * Decrypts and authenticates one delivery for this device: a legacy v1
 * record (ciphertext inline) or a record-v2 header plus its raw blob.
 */
export async function decryptNoteForDevice(input: unknown, device: DeviceKeyPair, blob?: Uint8Array): Promise<NotePayloadV1> {
  const version = (input as { version?: unknown } | null)?.version;
  if (version === 2) {
    const header = validateHeaderV2(input, blob);
    const slot = header.keySlots.find((candidate) => candidate.deviceId === device.deviceId);
    if (!slot) throw new Error('no key slot for this device');
    const wrapKey = await deriveWrapKey(device.privateKey, slot.ephemeralPublicKeySpki, header);
    const contentKey = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(fromBase64Url(slot.wrapIv, 'wrap IV')), additionalData: bytes(slotAad(header, device.deviceId)) },
      wrapKey, bytes(fromBase64Url(slot.wrappedContentKey, 'wrapped content key')),
    ));
    if (contentKey.byteLength !== CONTENT_KEY_BYTES) throw new Error('invalid wrapped content key');
    const key = await crypto.subtle.importKey('raw', bytes(contentKey), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(fromBase64Url(header.contentIv, 'content IV')), additionalData: bytes(contentAad(header)) },
      key, bytes(blob!),
    );
    return decodeNotePayloadBytes(new Uint8Array(plain));
  }
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
  return decodeNotePayloadBytes(new Uint8Array(plain));
}

/**
 * Decodes a decrypted payload in either format: bare JSON (v1) or the v2
 * frame — tag byte, u32 LE header length, JSON header, note bytes to EOF.
 */
export async function decodeNotePayloadBytes(plain: Uint8Array): Promise<NotePayloadV1> {
  if (plain.length > 0 && plain[0] === 0x7B) {
    let payload: unknown;
    try { payload = JSON.parse(decoder.decode(plain)); } catch { throw new Error('invalid encrypted note payload'); }
    return decodeNotePayload(payload);
  }
  if (plain.length < 5 || plain[0] !== PAYLOAD_V2_TAG) throw new Error('invalid encrypted note payload');
  const headerLength = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(1, true);
  if (headerLength < 2 || 5 + headerLength > plain.length) throw new Error('invalid encrypted note payload');
  let header: unknown;
  try { header = JSON.parse(decoder.decode(plain.subarray(5, 5 + headerLength))); } catch {
    throw new Error('invalid encrypted note payload');
  }
  return decodeNotePayload(header, plain.subarray(5 + headerLength));
}

/**
 * Validates a decrypted payload and restores the note: base64url (v1) or the
 * frame's trailing bytes (v2, passed as framedNote), inflated when
 * `"encoding":"gzip"` (capped at the device ceiling), then hash-checked
 * against the original bytes.
 */
export async function decodeNotePayload(payload: unknown, framedNote?: Uint8Array): Promise<NotePayloadV1> {
  if (payload === null || typeof payload !== 'object') throw new Error('invalid encrypted note payload');
  const value = payload as Partial<NotePayloadV1> & { version?: unknown; note?: unknown; encoding?: unknown };
  if (
    (value.version !== VERSION && value.version !== 2) || typeof value.filename !== 'string' || value.filename.length < 1 || value.filename.length > 512 ||
    typeof value.mime !== 'string' || value.mime.length < 1 || value.mime.length > 128 ||
    typeof value.sha256 !== 'string'
  ) throw new Error('invalid encrypted note payload');
  let note = framedNote;
  if (note === undefined) {
    if (typeof value.note !== 'string') throw new Error('invalid encrypted note payload');
    note = fromBase64Url(value.note, 'encrypted note bytes');
  }
  const encoding = value.encoding;
  if (encoding === 'gzip') {
    try {
      note = new Uint8Array(gunzipSync(note, { maxOutputLength: MAX_INFLATED_NOTE_BYTES }));
    } catch {
      throw new Error('invalid or oversized compressed note');
    }
  } else if (encoding !== undefined) {
    throw new Error('unsupported note encoding');
  }
  const sha256 = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(note))));
  if (value.sha256 !== sha256) throw new Error('encrypted note hash mismatch');
  return { filename: value.filename, mime: value.mime, note, sha256 };
}
