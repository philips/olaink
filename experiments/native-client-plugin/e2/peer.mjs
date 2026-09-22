#!/usr/bin/env node
// Independent WebCrypto peer for the E2 single-plugin relay experiment.
// It plays the "browser inbox" role against the staging server with a stub
// AuthGravity bearer token, and never shares code with the Java client.
//
//   node peer.mjs <command> [baseUrl]
//
// Commands: setup | pairing | receive | send-back | send-tampered | status
// State (throwaway keys) is kept in e2/peer-state.json.
import { webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();
const here = dirname(fileURLToPath(import.meta.url));
const stateFile = join(here, 'peer-state.json');
const AUTH = { Authorization: 'Bearer e2-stub-token', 'Content-Type': 'application/json' };

const b64 = bytes => Buffer.from(bytes).toString('base64url');
const fromB64 = value => new Uint8Array(Buffer.from(value, 'base64url'));
const view = value => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);

function loadState() {
  if (!existsSync(stateFile)) throw new Error('run `setup` first');
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

function saveState(state) {
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

const contentAad = record =>
  encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}`);
const slotAad = (record, deviceId) =>
  encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}\0${deviceId}`);

async function importPkcs8(b64url) {
  return subtle.importKey('pkcs8', view(fromB64(b64url)), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

async function deriveWrapKey(privateKey, peerSpki, record, usage) {
  const peer = await subtle.importKey('spki', view(fromB64(peerSpki)), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const material = await subtle.importKey('raw', view(new Uint8Array(bits)), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: view(new Uint8Array()), info: view(contentAad(record)) },
    material, { name: 'AES-GCM', length: 256 }, false, usage,
  );
}

async function decryptRecord(record, deviceId, privateKey) {
  const slot = record.keySlots.find(candidate => candidate?.deviceId === deviceId);
  if (!slot) throw new Error('no slot for this device');
  const wrapKey = await deriveWrapKey(privateKey, slot.ephemeralPublicKeySpki, record, ['decrypt']);
  const contentKey = new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv: view(fromB64(slot.wrapIv)), additionalData: view(slotAad(record, deviceId)) },
    wrapKey, view(fromB64(slot.wrappedContentKey)),
  ));
  const content = await subtle.importKey('raw', view(contentKey), 'AES-GCM', false, ['decrypt']);
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: view(fromB64(record.contentIv)), additionalData: view(contentAad(record)) },
    content, view(fromB64(record.ciphertext)),
  );
  const payload = JSON.parse(new TextDecoder().decode(plain));
  const note = fromB64(payload.note);
  const digest = b64(new Uint8Array(await subtle.digest('SHA-256', view(note))));
  if (digest !== payload.sha256) throw new Error('sha256 mismatch');
  return { ...payload, note, digest };
}

async function encryptForDirectory(note, filename, senderUsername, directory) {
  const record = {
    version: 1,
    id: crypto.randomUUID(),
    fromUserId: loadState().userId,
    fromDeviceId: loadState().deviceId,
    toUserId: directory.userId,
    toDirectoryVersion: directory.version,
    contentIv: b64(webcrypto.getRandomValues(new Uint8Array(12))),
    ciphertext: '',
    keySlots: [],
  };
  const payload = encoder.encode(JSON.stringify({
    version: 1, filename, mime: 'application/x-supernote',
    note: b64(note), sha256: b64(new Uint8Array(await subtle.digest('SHA-256', view(note)))),
    senderUsername,
  }));
  const contentKey = webcrypto.getRandomValues(new Uint8Array(32));
  const contentAes = await subtle.importKey('raw', view(contentKey), 'AES-GCM', false, ['encrypt']);
  record.ciphertext = b64(new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv: view(fromB64(record.contentIv)), additionalData: view(contentAad(record)) }, contentAes, payload,
  )));
  for (const device of directory.devices) {
    const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const wrapKey = await deriveWrapKey(ephemeral.privateKey, device.publicKeySpki, record, ['encrypt']);
    const wrapIv = webcrypto.getRandomValues(new Uint8Array(12));
    record.keySlots.push({
      deviceId: device.deviceId,
      ephemeralPublicKeySpki: b64(new Uint8Array(await subtle.exportKey('spki', ephemeral.publicKey))),
      wrapIv: b64(wrapIv),
      wrappedContentKey: b64(new Uint8Array(await subtle.encrypt(
        { name: 'AES-GCM', iv: view(wrapIv), additionalData: view(slotAad(record, device.deviceId)) }, wrapKey, contentKey,
      ))),
    });
  }
  return record;
}

async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...AUTH, ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${body.error ?? ''}`);
  return body;
}

async function setup(baseUrl) {
  const identity = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const state = {
    baseUrl,
    deviceId: `e2peer_browser_${Date.now().toString(36)}`,
    privatePkcs8B64url: b64(new Uint8Array(await subtle.exportKey('pkcs8', identity.privateKey))),
    publicSpkiB64url: b64(new Uint8Array(await subtle.exportKey('spki', identity.publicKey))),
    username: 'e2peer',
  };
  const account = await api(baseUrl, '/v1/account');
  state.userId = account.account.userId;
  await api(baseUrl, '/v1/account/username', { method: 'POST', body: JSON.stringify({ username: state.username }) });
  saveState(state);
  console.log(`setup ok: username=${state.username} userId=${state.userId} deviceId=${state.deviceId}`);
}

async function pairing(baseUrl) {
  const state = loadState();
  const result = await api(baseUrl, '/v1/pairings', {
    method: 'POST',
    body: JSON.stringify({ device: { deviceId: state.deviceId, publicKeySpki: state.publicSpkiB64url } }),
  });
  console.log(`pairing code: ${result.pairing.code} (expires ${new Date(result.pairing.expiresAt).toISOString()})`);
  console.log('Enter this code in the plugin within 10 minutes.');
}

async function receive(baseUrl) {
  const state = loadState();
  const privateKey = await importPkcs8(state.privatePkcs8B64url);
  const response = await api(baseUrl, '/v1/poll', { method: 'POST', body: JSON.stringify({ deviceId: state.deviceId }) });
  for (const record of response.records) {
    const payload = await decryptRecord(record, state.deviceId, privateKey);
    console.log(`received ${record.id}: filename=${payload.filename} sender=${payload.senderUsername} `
      + `sha256=${payload.sha256} bytes=${payload.note.length}`);
    const ack = await api(baseUrl, '/v1/ack', {
      method: 'POST', body: JSON.stringify({ deviceId: state.deviceId, recordIds: [record.id] }),
    });
    console.log(`acknowledged: ${JSON.stringify(ack)}`);
  }
  if (response.records.length === 0) console.log('inbox empty');
}

async function sendBack(baseUrl) {
  const state = loadState();
  const lookup = await api(baseUrl, `/v1/users/${state.username}`);
  const directory = lookup.directory;
  const note = new Uint8Array(8192);
  webcrypto.getRandomValues(note);
  note.set(encoder.encode('OLA-INK-E2-PEER-FIXTURE\0'), 0);
  const record = await encryptForDirectory(note, 'e2-peer-fixture.note', state.username, directory);
  await api(baseUrl, '/v1/notes', {
    method: 'POST', body: JSON.stringify({ username: state.username, record }),
  });
  console.log(`sent ${record.id} to ${state.username} for ${directory.devices.length} device(s): `
    + directory.devices.map(device => device.deviceId).join(', '));
}

async function sendTampered(baseUrl) {
  const state = loadState();
  const lookup = await api(baseUrl, `/v1/users/${state.username}`);
  const record = await encryptForDirectory(
    encoder.encode('OLA-INK-E2-TAMPERED-FIXTURE'), 'e2-tampered.note', state.username, lookup.directory,
  );
  // Keep the relay-valid outer shape but invalidate AES-GCM authentication.
  const bytes = fromB64(record.ciphertext);
  bytes[bytes.length - 1] ^= 1;
  record.ciphertext = b64(bytes);
  await api(baseUrl, '/v1/notes', {
    method: 'POST', body: JSON.stringify({ username: state.username, record }),
  });
  console.log(`sent tampered ${record.id}; it must remain unacknowledged by ${state.deviceId}`);
}

async function status(baseUrl) {
  const state = loadState();
  const lookup = await api(baseUrl, `/v1/users/${state.username}`);
  console.log(`directory version=${lookup.directory.version} devices=`
    + lookup.directory.devices.map(device => device.deviceId).join(', '));
}

const [command, baseUrlArg] = process.argv.slice(2);
const baseUrl = baseUrlArg ?? loadState().baseUrl;
switch (command) {
  case 'setup': await setup(baseUrl); break;
  case 'pairing': await pairing(baseUrl); break;
  case 'receive': await receive(baseUrl); break;
  case 'send-back': await sendBack(baseUrl); break;
  case 'send-tampered': await sendTampered(baseUrl); break;
  case 'status': await status(baseUrl); break;
  default:
    console.error('usage: node peer.mjs setup|pairing|receive|send-back|send-tampered|status [baseUrl]');
    process.exit(2);
}
