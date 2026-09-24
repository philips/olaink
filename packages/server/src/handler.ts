/**
 * Fetch-style request handler shared by both entry points: the Cloudflare
 * Worker (worker.ts) and the standalone Bun.serve binary (standalone.ts). It
 * contains no runtime-specific code.
 *
 *   GET  /v1/account (AuthGravity session required)
 *   POST /v1/account/username { username } (AuthGravity session required)
 *   GET  /v1/users/:username (AuthGravity session required)
 *   POST /v1/devices { deviceId, publicKeySpki } (AuthGravity session required)
 *   POST /v1/pairings { device } (AuthGravity session required)
 *   POST /v1/pairings/claim { code, device }
 *   POST /v1/companion/directory { deviceId, username } (paired-device session required)
 *   POST /v1/companion/notes { deviceId, username, record } (paired-device session required)
 *   POST /v1/companion/poll { deviceId } (paired-device session required)
 *   POST /v1/companion/ack { deviceId, recordIds } (paired-device session required)
 *   POST /v1/companion/logout { deviceId } (paired-device session required)
 *   POST /v1/notes { username, record } (AuthGravity session required)
 *   POST /v1/poll { deviceId } (AuthGravity session required)
 *   POST /v1/ack { deviceId, recordIds } (AuthGravity session required)
 *   GET  /         -> browser login and companion setup
 *   GET  /healthz  -> 200 'ok'
 *   GET  /commit   -> build-time Git commit (plain text)
 */

import { onboardPage } from './onboardPage.ts';
import { viewerAsset } from './viewerAsset.ts';
import { brandAsset } from './brandAsset.ts';
import { toBase64, utf8ByteLength, utf8Decode } from './bytes.ts';
import { D1Store, type D1DatabaseLike } from './d1Store.ts';
import { D1PairingClaimLimiter } from './d1RateLimiter.ts';
import type { NotePayloadStore } from './notePayloads.ts';
import { PrototypeNoteRelay } from './prototypeNoteRelay.ts';
import type { AuthGravityRequestCredentials, AuthGravityVerifier } from './authGravity.ts';
import { PrototypePairingService } from './prototypePairing.ts';
import { AccountUsernameLedger, normalizeUsername } from './accountUsernames.ts';
import type { EncryptedNoteRecordV1 } from './prototypeNoteCrypto.ts';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_PAIRING_CLAIMS_PER_MINUTE = 10;
const PAIRING_CLAIM_WINDOW_MS = 60_000;
// See plans/message-retention.md and docs/message-retention-policy.md: an
// undelivered note (and its ciphertext) is deleted automatically 14 days
// after it was sent, regardless of delivery state.
const NOTE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
// Android's WebViewAssetLoader has this fixed local HTTPS origin. Pairing
// establishes a device-scoped capability. It may send from, resolve a
// recipient for, poll, and acknowledge only that same paired device; account
// administration remains same-origin.
const ANDROID_ASSET_ORIGIN = 'https://appassets.androidplatform.net';
const COMPANION_PATHS = new Set([
  '/v1/pairings/claim',
  '/v1/companion/directory',
  '/v1/companion/notes',
  '/v1/companion/poll',
  '/v1/companion/ack',
  '/v1/companion/logout',
]);
const CSP = (nonce: string) => `default-src 'self'; script-src 'self' 'nonce-${nonce}'; connect-src 'self' https://authgravity.app.olaink.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'`;

export interface OlainkAppOptions {
  /** D1 binding, or the standalone SQLite shim. */
  db: D1DatabaseLike;
  /** R2 bucket adapter, or the standalone directory/memory store. */
  payloads: NotePayloadStore;
  authGravity: AuthGravityVerifier;
  /** Build commit served at /commit. */
  commit: string;
  now?: () => number;
  log?: (...args: unknown[]) => void;
  /** Overrides NOTE_RETENTION_MS; for tests only. */
  noteRetentionMs?: number;
}

type Body = Record<string, unknown>;

export class OlainkApp {
  public readonly store: D1Store;
  public readonly notes: PrototypeNoteRelay;
  public readonly pairing: PrototypePairingService;
  private readonly usernames: AccountUsernameLedger;
  private readonly pairingClaims: D1PairingClaimLimiter;
  private readonly authGravity: AuthGravityVerifier;
  private readonly commit: string;
  private readonly now: () => number;
  private readonly log: (...args: unknown[]) => void;
  private readonly noteRetentionMs: number;

  constructor(options: OlainkAppOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((...args) => console.log('[olaink-server]', ...args));
    this.commit = options.commit;
    this.authGravity = options.authGravity;
    this.noteRetentionMs = options.noteRetentionMs ?? NOTE_RETENTION_MS;
    this.store = D1Store.open(options.db);
    this.notes = new PrototypeNoteRelay({ store: this.store, payloads: options.payloads, now: this.now, log: this.log });
    this.pairing = new PrototypePairingService(this.notes, { now: this.now, store: this.store });
    this.usernames = new AccountUsernameLedger(this.store);
    this.pairingClaims = new D1PairingClaimLimiter(
      options.db, MAX_PAIRING_CLAIMS_PER_MINUTE, PAIRING_CLAIM_WINDOW_MS, this.now,
    );
  }

  /**
   * Deletes notes older than the retention window, regardless of delivery
   * state. Intended to run on a schedule (Worker Cron Trigger; standalone
   * timer/CLI flag), not from the request path. Returns the purged count.
   */
  async runRetentionSweep(): Promise<number> {
    return this.notes.purgeExpired(this.noteRetentionMs);
  }

  /**
   * Handles one request. `clientAddress` keys the pairing-claim rate limit:
   * CF-Connecting-IP in the Worker, the socket address in the standalone
   * binary.
   */
  async fetch(request: Request, clientAddress: string): Promise<Response> {
    const path = new URL(request.url).pathname;
    const companionRequest = COMPANION_PATHS.has(path) && request.headers.get('origin') === ANDROID_ASSET_ORIGIN;
    let response: Response;
    try {
      response = await this.dispatch(request, path, companionRequest, clientAddress);
    } catch (error) {
      this.log('request error:', error);
      response = json(500, { ok: false, error: 'internal' });
    }
    if (companionRequest) {
      response.headers.set('Access-Control-Allow-Origin', ANDROID_ASSET_ORIGIN);
      response.headers.set('Access-Control-Allow-Credentials', 'true');
      response.headers.set('Access-Control-Allow-Headers', 'content-type, x-olaink-device-session');
      response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.headers.set('Vary', 'Origin');
    }
    return response;
  }

  private async dispatch(request: Request, path: string, companionRequest: boolean, clientAddress: string): Promise<Response> {
    const method = request.method;
    if (method === 'OPTIONS') {
      return companionRequest ? new Response(null, { status: 204 }) : json(404, { ok: false, error: 'not found' });
    }

    if (method === 'GET' && path === '/healthz') {
      return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
    }
    if (method === 'GET' && path === '/commit') {
      return new Response(`${this.commit}\n`, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    // `/` is the public login/setup entrypoint.
    if (method === 'GET' && path === '/') return html(onboardPage);
    if (method === 'GET' && path === '/olaink-logo.svg') return immutableAsset(brandAsset, 'image/svg+xml');
    if (method === 'GET' && path === '/supernote-viewer.js') {
      return immutableAsset(viewerAsset, 'text/javascript; charset=utf-8');
    }
    if (method === 'GET' && path === '/v1/account') return this.handleAccount(request);
    if (method === 'GET' && path.startsWith('/v1/users/')) {
      return this.handleUsernameDirectory(request, path.slice('/v1/users/'.length));
    }

    if (method !== 'POST') return json(404, { ok: false, error: 'not_found' });

    let body: Body;
    try {
      const raw = await readBody(request);
      if (raw === null) throw new Error('body too large');
      body = JSON.parse(utf8Decode(raw)) as Body;
    } catch {
      return json(400, { ok: false, error: 'bad_request' });
    }

    switch (path) {
      case '/v1/account/username': return this.handleUsernameClaim(request, body);
      case '/v1/devices': return this.handleDeviceEnrollment(request, body);
      case '/v1/pairings': return this.handlePairingStart(request, body);
      case '/v1/pairings/claim': return this.handlePairingClaim(body, clientAddress);
      case '/v1/companion/directory': return this.handleCompanionDirectory(request, body);
      case '/v1/companion/notes': return this.handleCompanionNote(request, body);
      case '/v1/companion/poll': return this.handleCompanionPoll(request, body);
      case '/v1/companion/ack': return this.handleCompanionAck(request, body);
      case '/v1/companion/logout': return this.handleCompanionLogout(request, body);
      case '/v1/notes': return this.handleNote(request, body);
      case '/v1/poll': return this.handlePoll(request, body);
      case '/v1/ack': return this.handleAck(request, body);
      default: return json(404, { ok: false, error: 'not_found' });
    }
  }

  private async handleAccount(request: Request): Promise<Response> {
    const identity = await this.authGravity.verify(credentials(request));
    if (!identity) return json(401, { ok: false, error: 'auth' });
    const userId = await this.pairing.accountForSubject(identity.subject);
    const assignment = await this.usernames.usernameForUser(userId);
    return json(200, {
      ok: true,
      account: {
        userId,
        username: assignment?.status === 'active' ? assignment.username : null,
        assignedAt: assignment?.assignedAt ?? null,
      },
    });
  }

  private async handleUsernameClaim(request: Request, body: Body): Promise<Response> {
    const identity = await this.authGravity.verify(credentials(request));
    if (!identity) return json(401, { ok: false, error: 'auth' });
    if (Object.hasOwn(body, 'userId')) return json(400, { ok: false, error: 'invalid_request' });
    const normalized = normalizeUsername(body.username);
    if (!normalized.ok) return json(400, { ok: false, error: normalized.error });
    const userId = await this.pairing.accountForSubject(identity.subject);
    try {
      const result = await this.usernames.claim(userId, normalized.username, this.now());
      if (result.outcome === 'unavailable') return json(409, { ok: false, error: 'username_unavailable' });
      if (result.outcome === 'already_assigned') {
        return json(409, { ok: false, error: 'username_already_assigned', username: result.assignment.username });
      }
      return json(result.idempotent ? 200 : 201, {
        ok: true,
        result: 'username_assigned',
        account: {
          userId,
          username: result.assignment.username,
          assignedAt: result.assignment.assignedAt,
        },
      });
    } catch {
      // A uniqueness race must be indistinguishable from an existing active
      // or retired claim; never suggest an alternative automatically.
      return json(409, { ok: false, error: 'username_unavailable' });
    }
  }

  private async handleUsernameDirectory(request: Request, encodedUsername: string): Promise<Response> {
    const account = await this.account(request);
    if (account instanceof Response) return account;
    let rawUsername: string;
    try { rawUsername = decodeURIComponent(encodedUsername); } catch {
      return json(404, { ok: false, error: 'unknown_user' });
    }
    const normalized = normalizeUsername(rawUsername);
    const assignment = normalized.ok ? await this.usernames.resolveActiveUsername(normalized.username) : null;
    // Unknown and retired names deliberately have exactly the same response.
    if (!assignment) return json(404, { ok: false, error: 'unknown_user' });
    return json(200, { ok: true, username: assignment.username, directory: await this.notes.directory(assignment.userId) });
  }

  private async handleDeviceEnrollment(request: Request, body: Body): Promise<Response> {
    const account = await this.account(request);
    const device = body.device ?? body;
    if (account instanceof Response) return account;
    if (device === null || typeof device !== 'object' || Object.hasOwn(body, 'userId')) {
      return json(400, { ok: false, error: 'invalid_device' });
    }
    if ((await this.usernames.usernameForUser(account.userId))?.status !== 'active') {
      return json(409, { ok: false, error: 'username_required' });
    }
    try {
      const directory = await this.notes.registerDevice(account.userId, device as { deviceId: string; publicKeySpki: string });
      return json(201, { ok: true, directory });
    } catch { return json(400, { ok: false, error: 'invalid_device' }); }
  }

  private async handlePairingStart(request: Request, body: Body): Promise<Response> {
    const identity = await this.authGravity.verify(credentials(request));
    const device = body.device;
    if (!identity || device === null || typeof device !== 'object') return json(401, { ok: false, error: 'auth' });
    const userId = await this.pairing.accountForSubject(identity.subject);
    if ((await this.usernames.usernameForUser(userId))?.status !== 'active') {
      return json(409, { ok: false, error: 'username_required' });
    }
    try {
      const pairing = await this.pairing.start(identity.subject, device as { deviceId: string; publicKeySpki: string });
      return json(201, { ok: true, pairing });
    } catch {
      return json(400, { ok: false, error: 'invalid_pairing' });
    }
  }

  private async handlePairingClaim(body: Body, clientAddress: string): Promise<Response> {
    if (!await this.pairingClaims.hit(clientAddress)) return json(429, { ok: false, error: 'rate_limited' });
    const { code, device } = body;
    if (typeof code !== 'string' || device === null || typeof device !== 'object') {
      return json(400, { ok: false, error: 'invalid_pairing' });
    }
    try {
      const pairing = await this.pairing.claim(code, device as { deviceId: string; publicKeySpki: string });
      const username = (await this.usernames.usernameForUser(pairing.userId))?.username;
      return json(201, { ok: true, pairing: { ...pairing, ...(username ? { username } : {}) } });
    } catch {
      return json(400, { ok: false, error: 'invalid_pairing' });
    }
  }

  private async handleCompanionDirectory(request: Request, body: Body): Promise<Response> {
    const deviceId = await this.pairedDevice(request, body);
    if (deviceId instanceof Response) return deviceId;
    const normalized = normalizeUsername(body.username);
    const assignment = normalized.ok ? await this.usernames.resolveActiveUsername(normalized.username) : null;
    if (!assignment) return json(404, { ok: false, error: 'unknown_user' });
    return json(200, { ok: true, username: assignment.username, directory: await this.notes.directory(assignment.userId) });
  }

  private async handleCompanionNote(request: Request, body: Body): Promise<Response> {
    const deviceId = await this.pairedDevice(request, body);
    if (deviceId instanceof Response) return deviceId;
    const userId = await this.notes.ownerOfDevice(deviceId);
    if (!userId) return json(401, { ok: false, error: 'invalid_device_session' });
    return this.acceptNote(userId, body, deviceId);
  }

  private async handleCompanionPoll(request: Request, body: Body): Promise<Response> {
    const deviceId = await this.pairedDevice(request, body);
    if (deviceId instanceof Response) return deviceId;
    return json(200, { ok: true, records: await this.notes.poll(deviceId) });
  }

  private async handleCompanionAck(request: Request, body: Body): Promise<Response> {
    const deviceId = await this.pairedDevice(request, body);
    if (deviceId instanceof Response) return deviceId;
    if (!Array.isArray(body.recordIds) || !body.recordIds.every((id) => typeof id === 'string')) {
      return json(400, { ok: false, error: 'invalid_ack' });
    }
    return json(200, { ok: true, acknowledged: await this.notes.acknowledge(deviceId, body.recordIds) });
  }

  /** Removes exactly the bearer-authorized companion and invalidates its capability. */
  private async handleCompanionLogout(request: Request, body: Body): Promise<Response> {
    const deviceId = await this.pairedDevice(request, body);
    if (deviceId instanceof Response) return deviceId;
    const token = request.headers.get('x-olaink-device-session');
    if (token === null || !await this.pairing.revokeDeviceSession(token)
        || !await this.notes.unregisterDevice(deviceId)) {
      return json(401, { ok: false, error: 'invalid_device_session' });
    }
    return json(200, { ok: true, loggedOut: true });
  }

  /** Never accepts this device capability for account administration APIs. */
  private async pairedDevice(request: Request, body: Body): Promise<string | Response> {
    const token = request.headers.get('x-olaink-device-session');
    if (token === null) return json(401, { ok: false, error: 'device_session_required' });
    const deviceId = await this.pairing.deviceForSession(token);
    if (!deviceId || body.deviceId !== deviceId) return json(401, { ok: false, error: 'invalid_device_session' });
    return deviceId;
  }

  private async handleNote(request: Request, body: Body): Promise<Response> {
    const account = await this.account(request);
    if (account instanceof Response) return account;
    return this.acceptNote(account.userId, body);
  }

  /** Sends only a record cryptographically addressed from this authenticated device/account. */
  private async acceptNote(userId: string, body: Body, requiredDeviceId?: string): Promise<Response> {
    const record = body.record;
    if (typeof body.username !== 'string' || record === null || typeof record !== 'object') {
      return json(400, { ok: false, error: 'invalid_note' });
    }
    if (utf8ByteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) {
      return json(413, { ok: false, error: 'record_too_large' });
    }
    const normalized = normalizeUsername(body.username);
    const recipient = normalized.ok ? await this.usernames.resolveActiveUsername(normalized.username) : null;
    const note = record as EncryptedNoteRecordV1;
    if (!recipient || note.toUserId !== recipient.userId || note.fromUserId !== userId
        || (requiredDeviceId ? note.fromDeviceId !== requiredDeviceId : await this.notes.ownerOfDevice(note.fromDeviceId) !== userId)) {
      return json(400, { ok: false, error: 'invalid_note' });
    }
    try {
      await this.notes.send(note);
      return json(202, { ok: true, id: note.id });
    } catch {
      // Do not log a record: it contains opaque ciphertext and routing metadata.
      return json(400, { ok: false, error: 'invalid_note' });
    }
  }

  private async handlePoll(request: Request, body: Body): Promise<Response> {
    const account = await this.account(request);
    if (account instanceof Response) return account;
    if (typeof body.deviceId !== 'string') return json(400, { ok: false, error: 'invalid_device' });
    if (await this.notes.ownerOfDevice(body.deviceId) !== account.userId) {
      return json(404, { ok: false, error: 'unknown_device' });
    }
    return json(200, { ok: true, records: await this.notes.poll(body.deviceId) });
  }

  private async handleAck(request: Request, body: Body): Promise<Response> {
    const account = await this.account(request);
    if (account instanceof Response) return account;
    if (typeof body.deviceId !== 'string' || !Array.isArray(body.recordIds) || !body.recordIds.every((id) => typeof id === 'string')) {
      return json(400, { ok: false, error: 'invalid_ack' });
    }
    if (await this.notes.ownerOfDevice(body.deviceId) !== account.userId) {
      return json(404, { ok: false, error: 'unknown_device' });
    }
    return json(200, { ok: true, acknowledged: await this.notes.acknowledge(body.deviceId, body.recordIds) });
  }

  private async account(request: Request): Promise<{ userId: string } | Response> {
    const identity = await this.authGravity.verify(credentials(request));
    if (!identity) return json(401, { ok: false, error: 'auth' });
    return { userId: await this.pairing.accountForSubject(identity.subject) };
  }
}

function credentials(request: Request): AuthGravityRequestCredentials {
  return {
    authorization: request.headers.get('authorization') ?? undefined,
    cookie: request.headers.get('cookie') ?? undefined,
  };
}

function json(status: number, body: unknown): Response {
  // The inbox only uses same-origin, credentialed requests. Never expose
  // account/device endpoints to arbitrary web origins.
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function html(body: string): Response {
  const nonce = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  return new Response(body.replace('__CSP_NONCE__', nonce), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP(nonce),
    },
  });
}

function immutableAsset(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Reads the body up to the cap; null when it is (or declares itself) larger. */
async function readBody(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
