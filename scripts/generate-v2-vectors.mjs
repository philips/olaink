#!/usr/bin/env node
/**
 * Generates packages/plugin/vectors/note-v2-vectors.json — the WebCrypto/Java
 * interop oracle for record v2 (plans/binary-record-transport.md).
 *
 * The deterministic case reuses the committed record-v1 vectors' fixed
 * material (content key/IV, ephemeral ECDH keys, wrap IVs, routing, and note)
 * so both suites stay comparable; only the framing differs. The random case is
 * a fresh WebCrypto reference encryption with throwaway keys. Safe to commit:
 * every key is a throwaway.
 *
 * Run: node scripts/generate-v2-vectors.mjs
 */
import { webcrypto } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const bytes = (value) => new Uint8Array(Buffer.from(value, 'base64url'));
const source = (value) => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);

const contentAad = (recordId, toUserId, toDirectoryVersion) =>
  encoder.encode(`olaink.note.v1\0${recordId}\0${toUserId}\0${toDirectoryVersion}`);
const slotAad = (recordId, toUserId, toDirectoryVersion, deviceId) =>
  encoder.encode(`olaink.note.v1\0${recordId}\0${toUserId}\0${toDirectoryVersion}\0${deviceId}`);

async function aesGcm(key, iv, plain, aad) {
  const cryptoKey = key instanceof CryptoKey ? key : await subtle.importKey('raw', source(key), 'AES-GCM', false, ['encrypt']);
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: source(iv), additionalData: source(aad) }, cryptoKey, source(plain)));
}

async function deriveWrapKey(ephemeralPrivate, recipientSpki, aad) {
  const peer = await subtle.importKey('spki', source(bytes(recipientSpki)), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await subtle.deriveBits({ name: 'ECDH', public: peer }, ephemeralPrivate, 256);
  const material = await subtle.importKey('raw', source(new Uint8Array(secret)), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: source(new Uint8Array()), info: source(aad) }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
}

/** The v2 payload frame: tag byte, u32 LE header length, canonical JSON header, note to EOF. */
function framePayloadV2(headerFields, note) {
  const header = encoder.encode(JSON.stringify(headerFields));
  const out = new Uint8Array(5 + header.length + note.length);
  out[0] = 0x02;
  new DataView(out.buffer).setUint32(1, header.length, true);
  out.set(header, 5);
  out.set(note, 5 + header.length);
  return out;
}

/** Canonical v2 header field order: version, filename, mime, senderUsername, encoding?, sha256. */
async function encryptV2Deterministic(inputs, routing, recipients, contentKey, contentIv) {
  const note = bytes(inputs.noteB64url);
  const noteHash = b64url(new Uint8Array(await subtle.digest('SHA-256', source(note))));
  if (noteHash !== inputs.noteSha256B64url) throw new Error('v1 vector note hash mismatch');
  const aad = contentAad(routing.recordId, routing.toUserId, routing.toDirectoryVersion);
  const blob = await aesGcm(contentKey, contentIv, framePayloadV2({
    version: 2, filename: inputs.filename, mime: 'application/x-supernote',
    senderUsername: inputs.senderUsername, sha256: noteHash,
  }, note), aad);

  const slots = [];
  for (const recipient of recipients) {
    const ephemeral = await subtle.importKey('pkcs8', source(bytes(recipient.ephemeralPrivatePkcs8B64url)), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const wrapKey = await deriveWrapKey(ephemeral, recipient.publicSpkiB64url, aad);
    const wrapped = await aesGcm(
      wrapKey, bytes(recipient.wrapIvB64url), contentKey,
      slotAad(routing.recordId, routing.toUserId, routing.toDirectoryVersion, recipient.deviceId),
    );
    slots.push({
      deviceId: recipient.deviceId,
      ephemeralPublicKeySpki: recipient.ephemeralPublicSpkiB64url,
      wrapIv: recipient.wrapIvB64url,
      wrappedContentKey: b64url(wrapped),
    });
  }

  // Field order must match the Java implementation byte-for-byte.
  const headerJson = `{"version":2,"id":${JSON.stringify(routing.recordId)}`
    + `,"fromUserId":${JSON.stringify(routing.fromUserId)}`
    + `,"fromDeviceId":${JSON.stringify(routing.fromDeviceId)}`
    + `,"toUserId":${JSON.stringify(routing.toUserId)}`
    + `,"toDirectoryVersion":${routing.toDirectoryVersion}`
    + `,"contentIv":${JSON.stringify(inputs.contentIvB64url)}`
    + `,"keySlots":${JSON.stringify(slots)}`
    + `,"ciphertextBytes":${blob.length}}`;
  return { headerJson, blobB64url: b64url(blob) };
}

const v1 = JSON.parse(await readFile(new URL('../packages/plugin/vectors/note-v1-vectors.json', import.meta.url), 'utf8'));
const deterministic = v1.deterministic;
const deterministicInputs = {
  ...deterministic.payloadInputs,
  contentIvB64url: deterministic.contentIvB64url,
};
const deterministicV2 = await encryptV2Deterministic(
  deterministicInputs, deterministic.routing, deterministic.recipients,
  bytes(deterministic.contentKeyB64url), bytes(deterministic.contentIvB64url),
);

// Random case: a fresh WebCrypto reference encryption with a throwaway recipient.
const randomRecipient = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const randomSpki = b64url(new Uint8Array(await subtle.exportKey('spki', randomRecipient.publicKey)));
const randomPkcs8 = b64url(new Uint8Array(await subtle.exportKey('pkcs8', randomRecipient.privateKey)));
const randomEphemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const randomNote = new TextEncoder().encode('random record v2 interop note bytes');
const randomRecordId = crypto.randomUUID();
const randomContentKey = crypto.getRandomValues(new Uint8Array(32));
const randomContentIv = crypto.getRandomValues(new Uint8Array(12));
const randomRouting = {
  recordId: randomRecordId, fromUserId: 'account_v2_sender', fromDeviceId: 'device_v2_sender',
  toUserId: 'account_v2_receiver', toDirectoryVersion: 1,
};
const randomV2 = await encryptV2Deterministic(
  {
    filename: 'v2-random.note', senderUsername: 'v2-random-sender',
    noteB64url: b64url(randomNote), noteSha256B64url: b64url(new Uint8Array(await subtle.digest('SHA-256', source(randomNote)))),
    contentIvB64url: b64url(randomContentIv),
  },
  randomRouting,
  [{ deviceId: 'device_v2_recv_1', publicSpkiB64url: randomSpki,
     ephemeralPrivatePkcs8B64url: b64url(new Uint8Array(await subtle.exportKey('pkcs8', randomEphemeral.privateKey))),
     ephemeralPublicSpkiB64url: b64url(new Uint8Array(await subtle.exportKey('spki', randomEphemeral.publicKey))),
     wrapIvB64url: b64url(crypto.getRandomValues(new Uint8Array(12))) }],
  randomContentKey, randomContentIv,
);

const vectors = {
  schema: 1,
  description: 'Ola Ink record v2 (header + raw blob) WebCrypto/Java interop vectors; throwaway keys, safe to commit',
  deterministic: {
    payloadInputs: deterministicInputs,
    routing: deterministic.routing,
    contentKeyB64url: deterministic.contentKeyB64url,
    contentIvB64url: deterministic.contentIvB64url,
    recipients: deterministic.recipients,
    expectedHeaderJson: deterministicV2.headerJson,
    expectedBlobB64url: deterministicV2.blobB64url,
  },
  randomWebCrypto: {
    payloadInputs: {
      filename: 'v2-random.note', senderUsername: 'v2-random-sender',
      noteB64url: b64url(randomNote),
      noteSha256B64url: b64url(new Uint8Array(await subtle.digest('SHA-256', source(randomNote)))),
    },
    routing: randomRouting,
    recipientDeviceId: 'device_v2_recv_1',
    recipientPrivatePkcs8B64url: randomPkcs8,
    headerJson: randomV2.headerJson,
    blobB64url: randomV2.blobB64url,
  },
};

await writeFile(new URL('../packages/plugin/vectors/note-v2-vectors.json', import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`);
console.log('wrote packages/plugin/vectors/note-v2-vectors.json');
