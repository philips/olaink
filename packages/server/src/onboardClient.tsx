// @ts-nocheck -- the existing browser crypto controller is migrated intact;
// Preact now owns interactive workspace navigation while its controller is split into typed modules incrementally.
/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

type WorkspaceView = 'inbox' | 'send' | 'companion';
const workspaceViews: WorkspaceView[] = ['inbox', 'send', 'companion'];
let updateWorkspaceView: (view: WorkspaceView) => void = () => {};

function WorkspaceNavigation() {
  const [view, setView] = useState<WorkspaceView>(() => workspaceViews.includes(location.hash.slice(1) as WorkspaceView) ? location.hash.slice(1) as WorkspaceView : 'inbox');
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    updateWorkspaceView = setView;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    const media = window.matchMedia('(min-width: 42.01rem)');
    const closeOnDesktop = (event: MediaQueryListEvent) => { if (event.matches) setMenuOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    media.addEventListener('change', closeOnDesktop);
    return () => { updateWorkspaceView = () => {}; window.removeEventListener('keydown', closeOnEscape); media.removeEventListener('change', closeOnDesktop); };
  }, []);
  const select = (next: WorkspaceView) => {
    showView(next);
    setMenuOpen(false);
    if (next === 'companion') message('Create a one-use code, then enter it in the Supernote companion.');
  };
  return <>
    <button id="workspace-menu" type="button" aria-expanded={menuOpen} aria-controls="workspace-nav" onClick={() => setMenuOpen(open => !open)}><span class="hamburger" aria-hidden="true">☰</span>{menuOpen ? ' Close menu' : ' Menu'}</button>
    <nav id="workspace-nav" class={`sidebar${menuOpen ? ' menu-open' : ''}`} aria-label="Ola Ink workspace">
      <strong id="address"></strong>
      <button type="button" aria-current={view === 'inbox' ? 'page' : 'false'} onClick={() => select('inbox')}>Inbox</button>
      <button type="button" aria-current={view === 'send' ? 'page' : 'false'} onClick={() => select('send')}>Send a note</button>
      <button type="button" aria-current={view === 'companion' ? 'page' : 'false'} onClick={() => select('companion')}>Add Supernote companion</button>
    </nav>
  </>;
}

const AUTH_URL = 'https://authgravity.app.olaink.com';
const VERSION = 1, MAX_NOTE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const $ = selector => document.querySelector(selector);
const status = $('#status'), authSection = $('#auth-section');
const enrollSection = $('#enroll-section'), inboxSection = $('#inbox-section');
const viewer = $('#viewer'), validationViewer = $('#validation-viewer');
const sendForm = $('#send-form'), recipientInput = $('#recipient'), noteFileInput = $('#note-file'), sendNoteButton = $('#send-note');
const signupForm = $('#signup-form'), signupUsername = $('#signup-username');
const logoutButton = $('#logout');
const DB_NAME = 'olaink-inbox-v1', DEVICE_STORE = 'device', RECORD_STORE = 'records';
const deviceKey = () => `receiver:${account.userId}`;
let account, device, entries = new Map(), selectedId = null, syncing = false;
let activeView = ['inbox', 'send', 'companion'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'inbox';

function message(text) { status.textContent = text; }
function showView(view, updateHash = true) {
  if (!['inbox', 'send', 'companion'].includes(view)) return;
  activeView = view;
  updateWorkspaceView(view);
  for (const name of ['inbox', 'send', 'companion']) $(`#${name}-view`).hidden = name !== view;
  if (updateHash && location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
}

const workspaceNavigation = document.querySelector('#workspace-navigation');
if (!workspaceNavigation) throw new Error('workspace navigation mount is missing');
render(<WorkspaceNavigation />, workspaceNavigation);
function b64url(data) { const bytes = data instanceof Uint8Array ? data : new Uint8Array(data); let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function fromB64url(value, max = Infinity) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('malformed encrypted delivery'); const text = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4)); const out = Uint8Array.from(text, c => c.charCodeAt(0)); if (b64url(out) !== value) throw new Error('malformed encrypted delivery'); if (out.byteLength > max) throw new Error('encrypted delivery exceeds size limit'); return out; }
function recordAad(record) { return encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}`); }
function slotAad(record, id) { return encoder.encode(`olaink.note.v1\0${record.id}\0${record.toUserId}\0${record.toDirectoryVersion}\0${id}`); }
function authBytes(value) { return fromB64url(value); }
function registrationLabel(value) { return typeof value === 'string' && value.length >= 3 && value.length <= 24 && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value) ? value.toLowerCase() : null; }
function creationOptions(options, label) { const user = { ...options.user, id: authBytes(options.user.id) }; if (label) { user.name = label; user.displayName = label; } return { ...options, challenge: authBytes(options.challenge), user, excludeCredentials: options.excludeCredentials?.map(c => ({ ...c, id: authBytes(c.id) })) }; }
function requestOptions(options) { return { ...options, challenge: authBytes(options.challenge), allowCredentials: options.allowCredentials?.map(c => ({ ...c, id: authBytes(c.id) })) }; }
function credentialJson(credential) { const response = credential.response, output = { id: credential.id, rawId: b64url(credential.rawId), type: credential.type, response: { clientDataJSON: b64url(response.clientDataJSON) }, clientExtensionResults: credential.getClientExtensionResults() }; if ('attestationObject' in response) { output.response.attestationObject = b64url(response.attestationObject); output.response.transports = response.getTransports?.() ?? []; } else { output.response.authenticatorData = b64url(response.authenticatorData); output.response.signature = b64url(response.signature); if (response.userHandle) output.response.userHandle = b64url(response.userHandle); } return output; }
async function authApi(path, init = {}) { const response = await fetch(AUTH_URL + path, { ...init, credentials: 'include', headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } }); const body = await response.json(); if (!response.ok) throw new Error(body.error || `AuthGravity returned ${response.status}`); return body; }
async function authenticate(action, label) { if (!window.PublicKeyCredential) throw new Error('this browser does not support passkeys'); const options = await authApi(`/v1/${action}/options`); const credential = action === 'register' ? await navigator.credentials.create({ publicKey: creationOptions(options, label) }) : await navigator.credentials.get({ publicKey: requestOptions(options) }); if (!credential) throw new Error('passkey action was cancelled'); const result = await authApi(`/v1/${action}/verify`, { method: 'POST', body: JSON.stringify(credentialJson(credential)) }); if (!result.verified) throw new Error('AuthGravity did not verify the passkey'); }
async function api(path, init = {}) { const response = await fetch(path, { ...init, credentials: 'include', headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } }); const body = await response.json(); if (!response.ok) { const error = new Error(body.error || `Ola Ink returned ${response.status}`); error.code = body.error; throw error; } return body; }
async function whoami() { const response = await fetch(AUTH_URL + '/v1/whoami', { credentials: 'include' }); return response.ok ? response.json() : null; }

async function openDb() { return new Promise((resolve, reject) => { const request = indexedDB.open(DB_NAME, 1); request.onupgradeneeded = () => { request.result.createObjectStore(DEVICE_STORE); request.result.createObjectStore(RECORD_STORE, { keyPath: 'id' }); }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function dbGet(store, key) { const db = await openDb(); return new Promise((resolve, reject) => { const request = db.transaction(store).objectStore(store).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function dbAll() { const db = await openDb(); return new Promise((resolve, reject) => { const request = db.transaction(RECORD_STORE).objectStore(RECORD_STORE).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function saveEntry(entry) { const db = await openDb(); return new Promise((resolve, reject) => { const request = db.transaction(RECORD_STORE, 'readwrite').objectStore(RECORD_STORE).put(entry); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); }); }
async function removeEntry(id) { const db = await openDb(); return new Promise((resolve, reject) => { const request = db.transaction(RECORD_STORE, 'readwrite').objectStore(RECORD_STORE).delete(id); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); }); }
async function getDevice() { let saved = await dbGet(DEVICE_STORE, deviceKey()); if (saved) return saved; const generated = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']); const privateKey = await crypto.subtle.importKey('pkcs8', await crypto.subtle.exportKey('pkcs8', generated.privateKey), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']); saved = { deviceId: `inbox_${crypto.randomUUID().replace(/-/g, '')}`, privateKey, publicKeySpki: b64url(await crypto.subtle.exportKey('spki', generated.publicKey)) }; const db = await openDb(); await new Promise((resolve, reject) => { const request = db.transaction(DEVICE_STORE, 'readwrite').objectStore(DEVICE_STORE).put(saved, deviceKey()); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); }); return saved; }

function validateRecord(record) { if (!record || record.version !== VERSION || typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id) || record.toUserId !== account.userId || !Number.isInteger(record.toDirectoryVersion) || record.toDirectoryVersion < 1 || !Array.isArray(record.keySlots) || record.keySlots.length < 1) throw new Error('malformed delivery'); const slot = record.keySlots.find(item => item?.deviceId === device.deviceId); if (!slot || typeof slot.ephemeralPublicKeySpki !== 'string' || fromB64url(slot.wrapIv, 64).byteLength !== 12 || fromB64url(record.contentIv, 64).byteLength !== 12 || fromB64url(slot.wrappedContentKey, 64).byteLength < 16 || fromB64url(record.ciphertext, MAX_NOTE_BYTES * 3).byteLength < 16) throw new Error('delivery is not encrypted for this browser'); return slot; }
async function deriveWrapKey(privateKey, peerSpki, record, usages) { const peer = await crypto.subtle.importKey('spki', fromB64url(peerSpki), { name: 'ECDH', namedCurve: 'P-256' }, false, []); const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256); const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: recordAad(record) }, material, { name: 'AES-GCM', length: 256 }, false, usages); }
async function decryptRecord(record) { const slot = validateRecord(record); const wrapKey = await deriveWrapKey(device.privateKey, slot.ephemeralPublicKeySpki, record, ['decrypt']); const keyBytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(slot.wrapIv), additionalData: slotAad(record, device.deviceId) }, wrapKey, fromB64url(slot.wrappedContentKey))); if (keyBytes.byteLength !== 32) throw new Error('invalid wrapped content key'); const contentKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']); const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(record.contentIv), additionalData: recordAad(record) }, contentKey, fromB64url(record.ciphertext, MAX_NOTE_BYTES * 3)); let payload; try { payload = JSON.parse(decoder.decode(plain)); } catch { throw new Error('invalid encrypted note metadata'); } if (!payload || payload.version !== VERSION || typeof payload.filename !== 'string' || !payload.filename.toLowerCase().endsWith('.note') || payload.filename.length > 512 || payload.mime !== 'application/x-supernote' || typeof payload.note !== 'string' || typeof payload.sha256 !== 'string') throw new Error('unsupported encrypted note'); const note = fromB64url(payload.note, MAX_NOTE_BYTES); const digest = b64url(await crypto.subtle.digest('SHA-256', note)); if (digest !== payload.sha256) throw new Error('note integrity check failed'); return { filename: payload.filename, mime: payload.mime, note, sender: typeof payload.senderUsername === 'string' ? payload.senderUsername : 'Unknown sender' }; }
async function encryptForDirectory(note, filename, recipient, directory) {
  if (!Array.isArray(directory?.devices) || directory.devices.length < 1 || !Number.isInteger(directory.version) || directory.version < 1) throw new Error('recipient has no enrolled devices');
  if (directory.devices.length > 32) throw new Error('recipient has too many enrolled devices');
  const record = { version: VERSION, id: crypto.randomUUID(), fromUserId: account.userId, fromDeviceId: device.deviceId, toUserId: directory.userId, toDirectoryVersion: directory.version, contentIv: b64url(crypto.getRandomValues(new Uint8Array(12))), ciphertext: '', keySlots: [] };
  const hash = b64url(await crypto.subtle.digest('SHA-256', note));
  const plaintext = encoder.encode(JSON.stringify({ version: VERSION, filename, mime: 'application/x-supernote', note: b64url(note), sha256: hash, senderUsername: account.username }));
  const contentBytes = crypto.getRandomValues(new Uint8Array(32));
  const contentKey = await crypto.subtle.importKey('raw', contentBytes, 'AES-GCM', false, ['encrypt']);
  record.ciphertext = b64url(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fromB64url(record.contentIv), additionalData: recordAad(record) }, contentKey, plaintext));
  for (const recipientDevice of directory.devices) {
    if (!recipientDevice || typeof recipientDevice.deviceId !== 'string' || typeof recipientDevice.publicKeySpki !== 'string') throw new Error('recipient device directory is invalid');
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const wrapKey = await deriveWrapKey(ephemeral.privateKey, recipientDevice.publicKeySpki, record, ['encrypt']);
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv, additionalData: slotAad(record, recipientDevice.deviceId) }, wrapKey, contentBytes);
    record.keySlots.push({ deviceId: recipientDevice.deviceId, ephemeralPublicKeySpki: b64url(await crypto.subtle.exportKey('spki', ephemeral.publicKey)), wrapIv: b64url(wrapIv), wrappedContentKey: b64url(wrapped) });
  }
  return record;
}
// The pinned supernote-viewer supports an autoplay="<num>x" attribute: a
// note opened with it comes up blank and immediately replays its
// handwriting at that speed. The presentation property is set alongside it
// because the component marks any host presentation assignment as
// permanently host-owned, after which the attribute alone no longer starts
// playback; validation stays property-driven and paused.
const AUTOPLAY_SPEED = '5x';
function loadViewer(target, note, presentation = 'write-on-paused') { return new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('note viewer did not finish loading')), 15000); const done = event => { clearTimeout(timeout); target.removeEventListener('supernote-error', failed); resolve(event); }; const failed = event => { clearTimeout(timeout); target.removeEventListener('supernote-load', done); reject(event.detail?.error || new Error('unsupported note')); }; target.addEventListener('supernote-load', done, { once: true }); target.addEventListener('supernote-error', failed, { once: true }); if (presentation) target.presentation = presentation; target.noteData = note.buffer.slice(note.byteOffset, note.byteOffset + note.byteLength); }); }
async function checkViewer(note) { await customElements.whenDefined('supernote-viewer'); await loadViewer(validationViewer, note); }

function syncPage() { const named = account?.username; logoutButton.hidden = !account; authSection.hidden = Boolean(account); enrollSection.hidden = !named || Boolean(device); inboxSection.hidden = !named || !device; if (named && device) showView(activeView, false); if (!named) return; $('#pending-address').textContent = named; $('#address').textContent = named; $('#empty-address').textContent = named; renderList(); }
function renderList() { const list = $('#inbox-list'); list.textContent = ''; const values = [...entries.values()].sort((a, b) => b.receivedAt - a.receivedAt); $('#empty').hidden = values.length !== 0; for (const entry of values) { const item = document.createElement('li'), button = document.createElement('button'); button.className = entry.read ? '' : 'unread'; button.textContent = `${entry.payload.filename} — ${entry.payload.sender} — ${new Date(entry.receivedAt).toLocaleString()}`; button.onclick = () => openEntry(entry.id); item.append(button); list.append(item); } }
async function openEntry(id) { const entry = entries.get(id); if (!entry) return; try { message('Loading decrypted note locally…'); selectedId = id; $('#inbox-listing').hidden = true; $('#detail').hidden = false; $('#note-title').textContent = entry.payload.filename; $('#note-meta').textContent = `${entry.payload.sender} · ${Math.ceil(entry.payload.note.byteLength / 1024)} KiB`; viewer.presentation = 'static'; const event = await loadViewer(viewer, entry.payload.note, null); const { pageWidth, pageHeight } = event.detail || {}; if (Number.isFinite(pageWidth) && Number.isFinite(pageHeight) && pageWidth > 0 && pageHeight > 0) viewer.style.aspectRatio = `${pageWidth} / ${pageHeight}`; if (!entry.read) { entry.read = true; await saveEntry({ id: entry.id, record: entry.record, read: true, receivedAt: entry.receivedAt }); renderList(); } message('Note loaded.'); } catch (error) { $('#inbox-listing').hidden = false; $('#detail').hidden = true; selectedId = null; message(`Could not open this note: ${error.message}`); } }
async function restoreInbox() { entries.clear(); if (!device || !account) return; for (const stored of await dbAll()) { try { const payload = await decryptRecord(stored.record); entries.set(stored.id, { ...stored, payload }); } catch { /* Ciphertext remains local; do not expose metadata from a failed record. */ } } renderList(); }
async function sync() { if (syncing || !device) return; syncing = true; $('#sync').disabled = true; try { message('Syncing encrypted deliveries…'); const response = await api('/v1/poll', { method: 'POST', body: JSON.stringify({ deviceId: device.deviceId }) }); for (const record of response.records) { const existing = await dbGet(RECORD_STORE, record.id); const payload = await decryptRecord(record); await checkViewer(payload.note); if (!existing) await saveEntry({ id: record.id, record, read: false, receivedAt: Date.now() }); entries.set(record.id, { ...(existing || { id: record.id, record, read: false, receivedAt: Date.now() }), payload }); await api('/v1/ack', { method: 'POST', body: JSON.stringify({ deviceId: device.deviceId, recordIds: [record.id] }) }); } renderList(); message(entries.size ? 'Inbox is up to date.' : 'Inbox is empty.'); } catch (error) { message(`Sync paused: ${error.message}. The delivery remains on the relay so you can retry.`); } finally { syncing = false; $('#sync').disabled = false; } }
async function refresh() { try { const identity = await whoami(); if (!identity?.user_id) { account = null; device = null; syncPage(); message('Sign in with AuthGravity to set up Ola Ink.'); return; } account = (await api('/v1/account')).account; if (account.username) { device = await dbGet(DEVICE_STORE, deviceKey()); syncPage(); if (device) { await restoreInbox(); await sync(); } else message('Create this browser’s inbox key before sharing your address.'); } else { syncPage(); message('This account has no Ola Ink address. Create a new Ola Ink account to continue.'); } } catch (error) { message(`Account setup is unavailable: ${error.message}`); } }

signupForm.onsubmit = async event => { event.preventDefault(); const label = registrationLabel(signupUsername.value); if (!label) { message('Choose a username of 3–24 ASCII letters, numbers, and single dashes.'); return; } try { message(`Creating the ${label} passkey…`); await authenticate('register', label); account = (await api('/v1/account/username', { method: 'POST', body: JSON.stringify({ username: label }) })).account; await refresh(); } catch (error) { message(error.code === 'username_unavailable' ? 'That username is unavailable. This passkey is not connected to an Ola Ink address.' : `Registration failed: ${error.message}`); } };
$('#login').onclick = async () => { try { message('Waiting for passkey…'); await authenticate('login'); await refresh(); } catch (error) { message(`Login failed: ${error.message}`); } };
logoutButton.onclick = async () => { if (!account) return; logoutButton.disabled = true; try { message('Signing out…'); await authApi('/v1/logout', { method: 'POST' }); account = null; device = null; entries.clear(); selectedId = null; activeView = 'inbox'; $('#detail').hidden = true; $('#inbox-listing').hidden = false; $('#pairing-code').hidden = true; if (location.hash) history.replaceState(null, '', location.pathname); syncPage(); message('Signed out. This browser keeps its encrypted inbox; log back in with your passkey to read it.'); } catch (error) { message(`Could not sign out: ${error.message}`); } finally { logoutButton.disabled = false; } };
$('#enroll').onclick = async () => { const button = $('#enroll'); button.disabled = true; try { message('Creating a non-extractable browser receiver key…'); const next = await getDevice(); await api('/v1/devices', { method: 'POST', body: JSON.stringify({ deviceId: next.deviceId, publicKeySpki: next.publicKeySpki }) }); device = next; syncPage(); await restoreInbox(); message(`Browser inbox enrolled for ${account.username}. You can now share this address.`); } catch (error) { message(`Could not enroll this browser: ${error.message}`); } finally { button.disabled = false; } };
sendForm.onsubmit = async event => {
  event.preventDefault();
  if (!account?.username || !device) return;
  const file = noteFileInput.files?.[0];
  const recipient = recipientInput.value.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(recipient)) { message('Enter a valid recipient Ola Ink address.'); return; }
  if (!file || !file.name.toLowerCase().endsWith('.note')) { message('Choose a complete .note file.'); return; }
  if (file.size < 1 || file.size > MAX_NOTE_BYTES) { message(`Notes must be between 1 byte and ${MAX_NOTE_BYTES / 1024 / 1024} MiB.`); return; }
  sendNoteButton.disabled = true;
  try {
    message('Reading and verifying the selected note locally…');
    const note = new Uint8Array(await file.arrayBuffer());
    if (note.byteLength !== file.size) throw new Error('the selected file changed while it was read');
    await checkViewer(note);
    message(`Resolving ${recipient}'s encrypted device directory…`);
    const recipientInfo = await api(`/v1/users/${encodeURIComponent(recipient)}`);
    message('Encrypting the complete note locally…');
    const record = await encryptForDirectory(note, file.name, recipient, recipientInfo.directory);
    await api('/v1/notes', { method: 'POST', body: JSON.stringify({ username: recipientInfo.username, record }) });
    noteFileInput.value = '';
    message(`Encrypted note sent to ${recipientInfo.username}. Ola Ink did not upload a readable file.`);
  } catch (error) {
    message(`Could not send note: ${error.message}`);
  } finally { sendNoteButton.disabled = false; }
};
$('#sync').onclick = sync;
$('#copy-address').onclick = async () => { try { await navigator.clipboard.writeText(account.username); message('Ola Ink address copied.'); } catch { message(`Your Ola Ink address is ${account.username}.`); } };
window.addEventListener('popstate', () => showView(location.hash.slice(1) || 'inbox', false));
$('#create-pairing').onclick = async () => { const button = $('#create-pairing'); button.disabled = true; try { message('Creating one-use pairing code…'); const response = await api('/v1/pairings', { method: 'POST', body: JSON.stringify({ device: { deviceId: device.deviceId, publicKeySpki: device.publicKeySpki } }) }); const code = $('#pairing-code'); code.hidden = false; code.querySelector('strong').textContent = response.pairing.code; message(`Enter ${response.pairing.code} in the Supernote companion within 10 minutes.`); } catch (error) { message(`Could not create pairing code: ${error.message}`); button.disabled = false; } };
$('#close-note').onclick = () => { selectedId = null; $('#detail').hidden = true; $('#inbox-listing').hidden = false; message('Inbox ready.'); };
$('#delete').onclick = async () => { if (!selectedId || !confirm('Delete this encrypted local inbox copy? This does not delete the sender’s copy or undo delivery.')) return; await removeEntry(selectedId); entries.delete(selectedId); selectedId = null; $('#detail').hidden = true; $('#inbox-listing').hidden = false; renderList(); message('Local encrypted inbox copy deleted.'); };
window.addEventListener('online', sync); document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
await refresh();