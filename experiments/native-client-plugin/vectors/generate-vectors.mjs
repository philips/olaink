#!/usr/bin/env node
// Generate deterministic Ola Ink EncryptedNoteRecordV1 interop vectors using
// the same WebCrypto call shape as the production browser/client code
// (player.html / onboardClient.tsx). All keys are throwaway test material.
//
//   node experiments/native-client-plugin/vectors/generate-vectors.mjs
//
// The committed note-v1-vectors.json is the shared oracle for the Java
// implementation's host-JVM tests and the on-device E1 protocol self-test.
import { webcrypto } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();
const here = dirname(fileURLToPath(import.meta.url));

const b64 = bytes => Buffer.from(bytes).toString('base64url');
const bytes = value => new Uint8Array(Buffer.from(value, 'base64url'));
const view = value => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);

const contentAad = record =>
  encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}`);
const slotAad = (record, deviceId) =>
  encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}\0${deviceId}`);

async function importPkcs8(b64url) {
  return subtle.importKey('pkcs8', view(bytes(b64url)), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

async function deriveWrapKey(privateKey, peerSpkiB64url, record) {
  const peer = await subtle.importKey('spki', view(bytes(peerSpkiB64url)), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const material = await subtle.importKey('raw', view(new Uint8Array(bits)), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: view(new Uint8Array()), info: view(contentAad(record)) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

function payloadPlaintext(inputs) {
  // Exact production key order: version, filename, mime, note, sha256, senderUsername.
  return encoder.encode(JSON.stringify({
    version: 1,
    filename: inputs.filename,
    mime: 'application/x-supernote',
    note: inputs.noteB64url,
    sha256: inputs.noteSha256B64url,
    senderUsername: inputs.senderUsername,
  }));
}

function serializeRecord(record) {
  // Canonical order shared with the Java implementation's vector comparison.
  return JSON.stringify(record);
}

async function encryptWithFixedMaterial(routing, inputs, contentKey, contentIv, recipients) {
  const record = {
    version: 1,
    id: routing.recordId,
    fromUserId: routing.fromUserId,
    fromDeviceId: routing.fromDeviceId,
    toUserId: routing.toUserId,
    toDirectoryVersion: routing.toDirectoryVersion,
    contentIv: b64(contentIv),
    ciphertext: '',
    keySlots: [],
  };
  const contentAesKey = await subtle.importKey('raw', view(contentKey), 'AES-GCM', false, ['encrypt']);
  record.ciphertext = b64(new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv: view(contentIv), additionalData: view(contentAad(record)), tagLength: 128 },
    contentAesKey, payloadPlaintext(inputs),
  )));
  for (const recipient of recipients) {
    const ephemeralPrivate = await importPkcs8(recipient.ephemeralPrivatePkcs8B64url);
    const wrapKey = await deriveWrapKey(ephemeralPrivate, recipient.publicSpkiB64url, record);
    const wrapped = await subtle.encrypt(
      { name: 'AES-GCM', iv: view(bytes(recipient.wrapIvB64url)), additionalData: view(slotAad(record, recipient.deviceId)), tagLength: 128 },
      wrapKey, contentKey,
    );
    record.keySlots.push({
      deviceId: recipient.deviceId,
      ephemeralPublicKeySpki: recipient.ephemeralPublicSpkiB64url,
      wrapIv: recipient.wrapIvB64url,
      wrappedContentKey: b64(new Uint8Array(wrapped)),
    });
  }
  return record;
}

async function generateIdentity() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return {
    privatePkcs8B64url: b64(new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey))),
    publicSpkiB64url: b64(new Uint8Array(await subtle.exportKey('spki', pair.publicKey))),
  };
}

const randomBytes = length => webcrypto.getRandomValues(new Uint8Array(length));

// --- deterministic case -------------------------------------------------
const note = Buffer.from('Ola Ink E1 vector: whole .note bytes placeholder; never page/stroke data.', 'utf8');
const inputs = {
  filename: 'e1-vector.note',
  senderUsername: 'vector-sender',
  noteB64url: b64(note),
  noteSha256B64url: b64(webcrypto.getRandomValues(new Uint8Array(0)) && new Uint8Array(await subtle.digest('SHA-256', view(note)))),
};
const routing = {
  recordId: 'e1deterministicrecord0000000000000001',
  fromUserId: 'account_e1_sender',
  fromDeviceId: 'device_e1_sender_1',
  toUserId: 'account_e1_receiver',
  toDirectoryVersion: 4,
};
const contentKey = randomBytes(32);
const contentIv = randomBytes(12);
const recipients = [];
for (const deviceId of ['device_e1_recv_1', 'device_e1_recv_2']) {
  const identity = await generateIdentity();
  const ephemeral = await generateIdentity();
  recipients.push({
    deviceId,
    publicSpkiB64url: identity.publicSpkiB64url,
    privatePkcs8B64url: identity.privatePkcs8B64url,
    ephemeralPrivatePkcs8B64url: ephemeral.privatePkcs8B64url,
    ephemeralPublicSpkiB64url: ephemeral.publicSpkiB64url,
    wrapIvB64url: b64(randomBytes(12)),
  });
}
const deterministicRecord = await encryptWithFixedMaterial(routing, inputs, contentKey, contentIv, recipients);

// --- real-randomness WebCrypto case (fresh ephemeral generateKey) --------
const randomIdentity = await generateIdentity();
const randomNote = Buffer.from('random-ephemeral vector note bytes', 'utf8');
const randomInputs = {
  filename: 'e1-random.note',
  senderUsername: 'random-sender',
  noteB64url: b64(randomNote),
  noteSha256B64url: b64(new Uint8Array(await subtle.digest('SHA-256', view(randomNote)))),
};
const randomRouting = {
  recordId: 'e1randomrecord000000000000000000000002',
  fromUserId: 'account_e1_sender',
  fromDeviceId: 'device_e1_sender_1',
  toUserId: 'account_e1_receiver',
  toDirectoryVersion: 7,
};
const randomContentKey = randomBytes(32);
const randomRecord = {
  version: 1,
  id: randomRouting.recordId,
  fromUserId: randomRouting.fromUserId,
  fromDeviceId: randomRouting.fromDeviceId,
  toUserId: randomRouting.toUserId,
  toDirectoryVersion: randomRouting.toDirectoryVersion,
  contentIv: b64(randomBytes(12)),
  ciphertext: '',
  keySlots: [],
};
{
  const contentAesKey = await subtle.importKey('raw', view(randomContentKey), 'AES-GCM', false, ['encrypt']);
  randomRecord.ciphertext = b64(new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv: view(bytes(randomRecord.contentIv)), additionalData: view(contentAad(randomRecord)), tagLength: 128 },
    contentAesKey, payloadPlaintext(randomInputs),
  )));
  const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const wrapKey = await deriveWrapKey(ephemeral.privateKey, randomIdentity.publicSpkiB64url, randomRecord);
  const wrapIv = randomBytes(12);
  const wrapped = await subtle.encrypt(
    { name: 'AES-GCM', iv: view(wrapIv), additionalData: view(slotAad(randomRecord, 'device_e1_recv_random')), tagLength: 128 },
    wrapKey, randomContentKey,
  );
  randomRecord.keySlots.push({
    deviceId: 'device_e1_recv_random',
    ephemeralPublicKeySpki: b64(new Uint8Array(await subtle.exportKey('spki', ephemeral.publicKey))),
    wrapIv: b64(wrapIv),
    wrappedContentKey: b64(new Uint8Array(wrapped)),
  });
}

const vectors = {
  schema: 1,
  description: 'Ola Ink EncryptedNoteRecordV1 WebCrypto/Java interop vectors; throwaway keys, safe to commit',
  deterministic: {
    payloadInputs: inputs,
    routing,
    contentKeyB64url: b64(contentKey),
    contentIvB64url: b64(contentIv),
    recipients,
    expectedRecordJson: serializeRecord(deterministicRecord),
  },
  randomWebCrypto: {
    payloadInputs: randomInputs,
    routing: randomRouting,
    recordJson: serializeRecord(randomRecord),
    recipientPrivatePkcs8B64url: randomIdentity.privatePkcs8B64url,
    recipientDeviceId: 'device_e1_recv_random',
  },
};

mkdirSync(here, { recursive: true });
writeFileSync(join(here, 'note-v1-vectors.json'), `${JSON.stringify(vectors, null, 2)}\n`, 'utf8');
console.log(`wrote ${join(here, 'note-v1-vectors.json')}`);
