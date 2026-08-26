/**
 * HTTP shell over encrypted-note storage and pairing services.
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
 *   POST /v1/notes { username, record } (AuthGravity session required)
 *   POST /v1/poll { deviceId } (AuthGravity session required)
 *   POST /v1/ack { deviceId, recordIds } (AuthGravity session required)
 *   GET  /         -> browser login and companion setup
 *   GET  /healthz  -> 200 'ok'
 *   GET  /commit   -> build-time Git commit (plain text)
 */

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { onboardPage } from './onboardPage.ts';
import { viewerAsset } from './viewerAsset.ts';
import { buildCommit } from './buildInfo.ts';
import { brandAsset } from './brandAsset.ts';
import { PrototypeNoteRelay } from './prototypeNoteRelay.ts';
import { PrototypeSqliteStore } from './prototypeSqliteStore.ts';
import { AuthGravityWhoAmIVerifier, type AuthGravityVerifier } from './authGravity.ts';
import { PrototypePairingService } from './prototypePairing.ts';
import { AccountUsernameLedger, normalizeUsername } from './accountUsernames.ts';
import type { EncryptedNoteRecordV1 } from './prototypeNoteCrypto.ts';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_PAIRING_CLAIMS_PER_MINUTE = 10;
const PAIRING_CLAIM_WINDOW_MS = 60_000;
// Android's WebViewAssetLoader has this fixed local HTTPS origin. Pairing
// establishes a device-scoped capability. It may send from, resolve a
// recipient for, poll, and acknowledge only that same paired device; account
// administration remains same-origin.
const ANDROID_ASSET_ORIGIN = 'https://appassets.androidplatform.net';

export interface OlainkServerOptions {
  host?: string;
  port?: number;
  now?: () => number;
  /** Injected in tests; production uses AUTHGRAVITY_WHOAMI_URL. */
  authGravity?: AuthGravityVerifier;
  /** SQLite file. Bun deployments default to OLAINK_DATABASE or ./olaink.sqlite. */
  databasePath?: string;
}

export class OlainkServer {
  /** SQLite-backed in Bun deployments. */
  public readonly notes: PrototypeNoteRelay;
  public readonly pairing: PrototypePairingService;
  public readonly store: PrototypeSqliteStore | undefined;
  private readonly usernames: AccountUsernameLedger;
  private readonly authGravity: AuthGravityVerifier;
  private readonly now: () => number;
  private readonly pairingClaimAttempts = new Map<string, { count: number; resetAt: number }>();
  private readonly http: Server;

  constructor(opts: OlainkServerOptions = {}) {
    this.now = opts.now ?? Date.now;
    const databasePath = opts.databasePath ?? defaultDatabasePath();
    this.store = databasePath ? new PrototypeSqliteStore(databasePath) : undefined;
    // Older prototype builds persisted a server-resident echo private key.
    // The inbox relay never decrypts deliveries; remove that obsolete state on upgrade.
    this.store?.deleteServerState('echo_private_key_pkcs8_pem');
    this.notes = new PrototypeNoteRelay({
      ...(this.store ? { store: this.store } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    this.pairing = new PrototypePairingService(this.notes, {
      now: this.now,
      ...(this.store ? { store: this.store } : {}),
    });
    this.usernames = new AccountUsernameLedger(this.store);
    this.authGravity = opts.authGravity ?? new AuthGravityWhoAmIVerifier();

    this.http = createServer((req, res) => {
      void this.dispatch(req, res).catch((err) => {
        this.log('request error:', err);
        if (!res.headersSent) this.sendJson(res, 500, { ok: false, error: 'internal' });
        else res.end();
      });
    });
  }

  listen(opts: { host?: string; port?: number } = {}): Promise<void> {
    return new Promise((resolve) => {
      this.http.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', () => resolve());
    });
  }

  address(): { port: number; host: string } | null {
    const addr = this.http.address();
    if (addr === null || typeof addr === 'string') return null;
    return { port: addr.port, host: addr.address };
  }

  close(): Promise<void> {
    // closeAllConnections: fetch clients keep idle keep-alive sockets open,
    // which would otherwise stall close() indefinitely.
    this.http.closeAllConnections?.();
    return new Promise((resolve) => this.http.close(() => {
      this.store?.close();
      resolve();
    }));
  }

  private log(...args: unknown[]): void {
    console.log('[olaink-server]', ...args);
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      // The inbox only uses same-origin, credentialed requests. Never expose
      // account/device endpoints to arbitrary web origins.
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  private sendCommit(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(`${buildCommit}\n`),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(`${buildCommit}\n`);
  }

  private sendBrandAsset(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Content-Length': Buffer.byteLength(brandAsset),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(brandAsset);
  }

  private sendViewer(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(viewerAsset),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(viewerAsset);
  }

  private sendHtml(res: ServerResponse, body: string): void {
    const nonce = randomBytes(16).toString('base64');
    const rendered = body.replace('__CSP_NONCE__', nonce);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(rendered),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; connect-src 'self' https://authgravity.app.olaink.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'`,
    });
    res.end(rendered);
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (c: Buffer) => {
        total += c.length;
        if (total > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const companionRequest = [
      '/v1/pairings/claim',
      '/v1/companion/directory',
      '/v1/companion/notes',
      '/v1/companion/poll',
      '/v1/companion/ack',
    ].includes(path) && req.headers.origin === ANDROID_ASSET_ORIGIN;
    if (companionRequest) {
      res.setHeader('Access-Control-Allow-Origin', ANDROID_ASSET_ORIGIN);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-olaink-device-session');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (companionRequest) {
        res.writeHead(204);
        res.end();
      } else {
        this.sendJson(res, 404, { ok: false, error: 'not found' });
      }
      return;
    }

    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && path === '/commit') {
      this.sendCommit(res);
      return;
    }

    // `/` is the public login/setup entrypoint.
    if (req.method === 'GET' && path === '/') {
      this.sendHtml(res, onboardPage);
      return;
    }

    if (req.method === 'GET' && path === '/olaink-logo.svg') {
      this.sendBrandAsset(res);
      return;
    }

    if (req.method === 'GET' && path === '/supernote-viewer.js') {
      this.sendViewer(res);
      return;
    }

    if (req.method === 'GET' && path === '/v1/account') {
      await this.handleAccount(req, res);
      return;
    }

    if (req.method === 'GET' && path.startsWith('/v1/users/')) {
      await this.handleUsernameDirectory(req, path.slice('/v1/users/'.length), res);
      return;
    }

    if (req.method !== 'POST') {
      this.sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    let body: Record<string, unknown>;
    try {
      const raw = await this.readBody(req);
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      this.sendJson(res, 400, { ok: false, error: 'bad_request' });
      return;
    }

    if (path === '/v1/account/username') return this.handleUsernameClaim(req, body, res);
    if (path === '/v1/devices') return this.handleDeviceEnrollment(req, body, res);
    if (path === '/v1/pairings') return this.handlePairingStart(req, body, res);
    if (path === '/v1/pairings/claim') return this.handlePairingClaim(req, body, res);
    if (path === '/v1/companion/directory') return this.handleCompanionDirectory(req, body, res);
    if (path === '/v1/companion/notes') return this.handleCompanionNote(req, body, res);
    if (path === '/v1/companion/poll') return this.handleCompanionPoll(req, body, res);
    if (path === '/v1/companion/ack') return this.handleCompanionAck(req, body, res);
    if (path === '/v1/notes') return this.handleNote(req, body, res);
    if (path === '/v1/poll') return this.handlePoll(req, body, res);
    if (path === '/v1/ack') return this.handleAck(req, body, res);

    this.sendJson(res, 404, { ok: false, error: 'not_found' });
  }

  private async handleAccount(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const identity = await this.authGravity.verify(req.headers);
    if (!identity) {
      this.sendJson(res, 401, { ok: false, error: 'auth' });
      return;
    }
    const userId = this.pairing.accountForSubject(identity.subject);
    const assignment = this.usernames.usernameForUser(userId);
    this.sendJson(res, 200, {
      ok: true,
      account: {
        userId,
        username: assignment?.status === 'active' ? assignment.username : null,
        assignedAt: assignment?.assignedAt ?? null,
      },
    });
  }

  private async handleUsernameClaim(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const identity = await this.authGravity.verify(req.headers);
    if (!identity) {
      this.sendJson(res, 401, { ok: false, error: 'auth' });
      return;
    }
    if (Object.hasOwn(body, 'userId')) {
      this.sendJson(res, 400, { ok: false, error: 'invalid_request' });
      return;
    }
    const normalized = normalizeUsername(body.username);
    if (!normalized.ok) {
      this.sendJson(res, 400, { ok: false, error: normalized.error });
      return;
    }
    const userId = this.pairing.accountForSubject(identity.subject);
    try {
      const result = this.usernames.claim(userId, normalized.username, this.now());
      if (result.outcome === 'unavailable') {
        this.sendJson(res, 409, { ok: false, error: 'username_unavailable' });
      } else if (result.outcome === 'already_assigned') {
        this.sendJson(res, 409, { ok: false, error: 'username_already_assigned', username: result.assignment.username });
      } else {
        this.sendJson(res, result.idempotent ? 200 : 201, {
          ok: true,
          result: 'username_assigned',
          account: {
            userId,
            username: result.assignment.username,
            assignedAt: result.assignment.assignedAt,
          },
        });
      }
    } catch {
      // A SQLite uniqueness race must be indistinguishable from an existing
      // active or retired claim; never suggest an alternative automatically.
      this.sendJson(res, 409, { ok: false, error: 'username_unavailable' });
    }
  }

  private async handleUsernameDirectory(req: IncomingMessage, encodedUsername: string, res: ServerResponse): Promise<void> {
    if (!await this.account(req, res)) return;
    let rawUsername: string;
    try { rawUsername = decodeURIComponent(encodedUsername); } catch {
      this.sendJson(res, 404, { ok: false, error: 'unknown_user' }); return;
    }
    const normalized = normalizeUsername(rawUsername);
    const assignment = normalized.ok ? this.usernames.resolveActiveUsername(normalized.username) : null;
    // Unknown and retired names deliberately have exactly the same response.
    if (!assignment) { this.sendJson(res, 404, { ok: false, error: 'unknown_user' }); return; }
    this.sendJson(res, 200, { ok: true, username: assignment.username, directory: this.notes.directory(assignment.userId) });
  }

  private async handleDeviceEnrollment(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const account = await this.account(req, res);
    const device = body.device ?? body;
    if (!account) return;
    if (device === null || typeof device !== 'object' || Object.hasOwn(body, 'userId')) {
      this.sendJson(res, 400, { ok: false, error: 'invalid_device' }); return;
    }
    if (this.usernames.usernameForUser(account.userId)?.status !== 'active') {
      this.sendJson(res, 409, { ok: false, error: 'username_required' }); return;
    }
    try {
      const directory = this.notes.registerDevice(account.userId, device as { deviceId: string; publicKeySpki: string });
      this.sendJson(res, 201, { ok: true, directory });
    } catch { this.sendJson(res, 400, { ok: false, error: 'invalid_device' }); }
  }

  private async handlePairingStart(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const identity = await this.authGravity.verify(req.headers);
    const device = body.device;
    if (!identity || device === null || typeof device !== 'object') {
      this.sendJson(res, 401, { ok: false, error: 'auth' });
      return;
    }
    const userId = this.pairing.accountForSubject(identity.subject);
    if (this.usernames.usernameForUser(userId)?.status !== 'active') {
      this.sendJson(res, 409, { ok: false, error: 'username_required' });
      return;
    }
    try {
      const pairing = this.pairing.start(identity.subject, device as { deviceId: string; publicKeySpki: string });
      this.sendJson(res, 201, { ok: true, pairing });
    } catch {
      this.sendJson(res, 400, { ok: false, error: 'invalid_pairing' });
    }
  }

  private handlePairingClaim(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): void {
    if (!this.allowPairingClaim(req)) {
      this.sendJson(res, 429, { ok: false, error: 'rate_limited' });
      return;
    }
    const { code, device } = body;
    if (typeof code !== 'string' || device === null || typeof device !== 'object') {
      this.sendJson(res, 400, { ok: false, error: 'invalid_pairing' });
      return;
    }
    try {
      const pairing = this.pairing.claim(code, device as { deviceId: string; publicKeySpki: string });
      const username = this.usernames.usernameForUser(pairing.userId)?.username;
      this.sendJson(res, 201, { ok: true, pairing: { ...pairing, ...(username ? { username } : {}) } });
    } catch {
      this.sendJson(res, 400, { ok: false, error: 'invalid_pairing' });
    }
  }

  private handleCompanionDirectory(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): void {
    if (!this.pairedDevice(req, body, res)) return;
    const normalized = normalizeUsername(body.username);
    const assignment = normalized.ok ? this.usernames.resolveActiveUsername(normalized.username) : null;
    if (!assignment) { this.sendJson(res, 404, { ok: false, error: 'unknown_user' }); return; }
    this.sendJson(res, 200, { ok: true, username: assignment.username, directory: this.notes.directory(assignment.userId) });
  }

  private async handleCompanionNote(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const deviceId = this.pairedDevice(req, body, res);
    if (!deviceId) return;
    const userId = this.notes.ownerOfDevice(deviceId);
    if (!userId) { this.sendJson(res, 401, { ok: false, error: 'invalid_device_session' }); return; }
    await this.acceptNote(userId, body, res, deviceId);
  }

  private handleCompanionPoll(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): void {
    const deviceId = this.pairedDevice(req, body, res);
    if (!deviceId) return;
    this.sendJson(res, 200, { ok: true, records: this.notes.poll(deviceId) });
  }

  private handleCompanionAck(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): void {
    const deviceId = this.pairedDevice(req, body, res);
    if (!deviceId) return;
    if (!Array.isArray(body.recordIds) || !body.recordIds.every((id) => typeof id === 'string')) {
      this.sendJson(res, 400, { ok: false, error: 'invalid_ack' }); return;
    }
    this.sendJson(res, 200, { ok: true, acknowledged: this.notes.acknowledge(deviceId, body.recordIds) });
  }

  /** Never accepts this device capability for account administration APIs. */
  private pairedDevice(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): string | null {
    const token = req.headers['x-olaink-device-session'];
    if (typeof token !== 'string') {
      this.sendJson(res, 401, { ok: false, error: 'device_session_required' }); return null;
    }
    const deviceId = this.pairing.deviceForSession(token);
    if (!deviceId || body.deviceId !== deviceId) {
      this.sendJson(res, 401, { ok: false, error: 'invalid_device_session' }); return null;
    }
    return deviceId;
  }

  private allowPairingClaim(req: IncomingMessage): boolean {
    const key = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const previous = this.pairingClaimAttempts.get(key);
    const attempt = !previous || previous.resetAt <= now
      ? { count: 1, resetAt: now + PAIRING_CLAIM_WINDOW_MS }
      : { ...previous, count: previous.count + 1 };
    this.pairingClaimAttempts.set(key, attempt);
    return attempt.count <= MAX_PAIRING_CLAIMS_PER_MINUTE;
  }

  private async handleNote(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const account = await this.account(req, res);
    if (!account) return;
    await this.acceptNote(account.userId, body, res);
  }

  /** Sends only a record cryptographically addressed from this authenticated device/account. */
  private async acceptNote(userId: string, body: Record<string, unknown>, res: ServerResponse, requiredDeviceId?: string): Promise<void> {
    const record = body.record;
    if (typeof body.username !== 'string' || record === null || typeof record !== 'object') {
      this.sendJson(res, 400, { ok: false, error: 'invalid_note' }); return;
    }
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) {
      this.sendJson(res, 413, { ok: false, error: 'record_too_large' }); return;
    }
    const normalized = normalizeUsername(body.username);
    const recipient = normalized.ok ? this.usernames.resolveActiveUsername(normalized.username) : null;
    const note = record as EncryptedNoteRecordV1;
    if (!recipient || note.toUserId !== recipient.userId || note.fromUserId !== userId
        || (requiredDeviceId ? note.fromDeviceId !== requiredDeviceId : this.notes.ownerOfDevice(note.fromDeviceId) !== userId)) {
      this.sendJson(res, 400, { ok: false, error: 'invalid_note' }); return;
    }
    try {
      await this.notes.send(note);
      this.sendJson(res, 202, { ok: true, id: note.id });
    } catch {
      // Do not log a record: it contains opaque ciphertext and routing metadata.
      this.sendJson(res, 400, { ok: false, error: 'invalid_note' });
    }
  }

  private async handlePoll(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const account = await this.account(req, res);
    if (!account) return;
    if (typeof body.deviceId !== 'string') { this.sendJson(res, 400, { ok: false, error: 'invalid_device' }); return; }
    if (this.notes.ownerOfDevice(body.deviceId) !== account.userId) {
      this.sendJson(res, 404, { ok: false, error: 'unknown_device' }); return;
    }
    this.sendJson(res, 200, { ok: true, records: this.notes.poll(body.deviceId) });
  }

  private async handleAck(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const account = await this.account(req, res);
    if (!account) return;
    if (typeof body.deviceId !== 'string' || !Array.isArray(body.recordIds) || !body.recordIds.every((id) => typeof id === 'string')) {
      this.sendJson(res, 400, { ok: false, error: 'invalid_ack' }); return;
    }
    if (this.notes.ownerOfDevice(body.deviceId) !== account.userId) {
      this.sendJson(res, 404, { ok: false, error: 'unknown_device' }); return;
    }
    this.sendJson(res, 200, { ok: true, acknowledged: this.notes.acknowledge(body.deviceId, body.recordIds) });
  }

  private async account(req: IncomingMessage, res: ServerResponse): Promise<{ userId: string } | null> {
    const identity = await this.authGravity.verify(req.headers);
    if (!identity) { this.sendJson(res, 401, { ok: false, error: 'auth' }); return null; }
    return { userId: this.pairing.accountForSubject(identity.subject) };
  }
}

function defaultDatabasePath(): string | undefined {
  // Keep Node/vitest's existing in-memory test setup working. `main.ts` is run
  // by Bun in deployment, where persistence is mandatory by default.
  return (globalThis as { Bun?: unknown }).Bun
    ? process.env['OLAINK_DATABASE'] ?? './olaink.sqlite'
    : undefined;
}

export async function startOlainkServer(opts: OlainkServerOptions = {}): Promise<OlainkServer> {
  const server = new OlainkServer(opts);
  await server.listen({ host: opts.host ?? '0.0.0.0', port: opts.port ?? 8002 });
  return server;
}
