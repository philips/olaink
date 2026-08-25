/**
 * HTTP shell over Registry+Router.
 *
 *   POST /v1/hello { username, deviceType, client }
 *     -> 200 { ok, username, token } | 400 { ok:false, error }
 *   POST /v1/send  { username, token, msgs: Envelope[] }
 *     -> 200 { ok:true } | 401 { ok:false, error:'auth' }
 *   POST /v1/poll  { username, token, waitMs }
 *     -> 200 { in: Envelope[] } | 401 { ok:false, error:'auth' }
 *   POST /v1/prototype/devices { userId, deviceId, publicKeySpki }
 *   GET  /v1/prototype/devices/:userId
 *   POST /v1/prototype/pairings { device } (AuthGravity session required)
 *   POST /v1/prototype/pairings/claim { code, device }
 *   POST /v1/prototype/notes { record: EncryptedNoteRecordV1 }
 *   POST /v1/prototype/poll { deviceId }
 *   POST /v1/prototype/ack { deviceId, recordIds }
 *   GET  /healthz  -> 200 'ok'
 */

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isValidUsername } from '@wrtn/protocol';
import type { Envelope } from '@wrtn/protocol';
import { Registry } from './registry.ts';
import { Router } from './router.ts';
import { SWAPTEST } from './registry.ts';
import { generateSwapTestPage } from './swapTest.ts';
import { PrototypeNoteRelay } from './prototypeNoteRelay.ts';
import { AuthGravityWhoAmIVerifier, type AuthGravityVerifier } from './authGravity.ts';
import { PrototypePairingService } from './prototypePairing.ts';
import type { EncryptedNoteRecordV1 } from './prototypeNoteCrypto.ts';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_WAIT_MS = 25_000;
const ONBOARD_PAGE = new URL('../public/onboard.html', import.meta.url);

export interface WrtnServerOptions {
  host?: string;
  port?: number;
  now?: () => number;
  /** Injected in tests; production uses AUTHGRAVITY_WHOAMI_URL. */
  authGravity?: AuthGravityVerifier;
}

export class WrtnServer {
  public readonly registry: Registry;
  public readonly router: Router;
  /** In-memory encrypted whole-note prototype; independent of the legacy relay. */
  public readonly notes: PrototypeNoteRelay;
  public readonly pairing: PrototypePairingService;
  private readonly authGravity: AuthGravityVerifier;
  private readonly http: Server;

  constructor(opts: WrtnServerOptions = {}) {
    this.registry = new Registry(opts.now);
    this.router = new Router({ registry: this.registry });
    this.notes = new PrototypeNoteRelay();
    this.pairing = new PrototypePairingService(this.notes, opts.now ? { now: opts.now } : {});
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
    this.registry.startSweeper();
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
    this.registry.stopSweeper();
    // closeAllConnections: fetch clients keep idle keep-alive sockets open,
    // which would otherwise stall close() indefinitely.
    this.http.closeAllConnections?.();
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  private log(...args: unknown[]): void {
    console.log('[wrtn-server]', ...args);
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Access-Control-Allow-Origin': '*', // prototype API has no browser credentials
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  private sendHtml(res: ServerResponse, body: Buffer): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
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

    if (req.method === 'OPTIONS' && path.startsWith('/v1/prototype/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && path === '/prototype/onboard') {
      this.sendHtml(res, await readFile(ONBOARD_PAGE));
      return;
    }

    if (req.method === 'GET' && path.startsWith('/v1/prototype/devices/')) {
      const userId = decodeURIComponent(path.slice('/v1/prototype/devices/'.length));
      const directory = this.notes.directory(userId);
      if (directory.devices.length === 0) {
        this.sendJson(res, 404, { ok: false, error: 'unknown_user' });
      } else {
        this.sendJson(res, 200, { ok: true, directory });
      }
      return;
    }

    // Debug: who is connected (legacy prototype observability).
    if (req.method === 'GET' && path === '/v1/peers') {
      this.sendJson(res, 200, { ok: true, peers: this.registry.peers() });
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

    if (path === '/v1/hello') return this.handleHello(body, res);
    if (path === '/v1/send') return this.handleSend(body, res);
    if (path === '/v1/poll') return this.handlePoll(body, res);
    if (path === '/v1/prototype/devices') return this.handlePrototypeDevice(body, res);
    if (path === '/v1/prototype/pairings') return this.handlePrototypePairingStart(req, body, res);
    if (path === '/v1/prototype/pairings/claim') return this.handlePrototypePairingClaim(body, res);
    if (path === '/v1/prototype/notes') return this.handlePrototypeNote(body, res);
    if (path === '/v1/prototype/poll') return this.handlePrototypePoll(body, res);
    if (path === '/v1/prototype/ack') return this.handlePrototypeAck(body, res);

    // Test endpoint (issue #2): the `swaptest` bot generates a new page
    // addressed to `to` and routes it like a real page.send. No auth — this
    // is a dev/test facility, not a product API.
    if (path === '/v1/test/swaptest/page') return this.handleSwapTestPage(body, res);

    this.sendJson(res, 404, { ok: false, error: 'not_found' });
  }

  private handleHello(body: Record<string, unknown>, res: ServerResponse): void {
    const username = body.username;
    const deviceType = body.deviceType;
    const client = body.client;
    if (
      typeof username !== 'string' ||
      typeof deviceType !== 'number' ||
      typeof client !== 'string' ||
      !isValidUsername(username)
    ) {
      this.sendJson(res, 400, { ok: false, error: 'invalid_hello' });
      return;
    }
    const rec = this.registry.hello(username, deviceType, client);
    this.sendJson(res, 200, { ok: true, username: rec.username, token: rec.token });
  }

  private handleSend(body: Record<string, unknown>, res: ServerResponse): void {
    const rec = this.auth(body);
    if (rec === null) {
      this.sendJson(res, 401, { ok: false, error: 'auth' });
      return;
    }
    const msgs = body.msgs;
    if (!Array.isArray(msgs)) {
      this.sendJson(res, 400, { ok: false, error: 'bad_request' });
      return;
    }
    for (const msg of msgs) {
      // The router validates envelope shape; malformed entries are skipped.
      try {
        if (typeof msg === 'object' && msg !== null) {
          this.router.handle(rec.username, msg as Envelope);
        }
      } catch (err) {
        this.log('handler error:', err);
      }
    }
    this.sendJson(res, 200, { ok: true });
  }

  private async handlePoll(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const rec = this.auth(body);
    if (rec === null) {
      this.sendJson(res, 401, { ok: false, error: 'auth' });
      return;
    }
    const waitRaw = body.waitMs;
    const waitMs =
      typeof waitRaw === 'number' && Number.isFinite(waitRaw)
        ? Math.max(0, Math.min(waitRaw, MAX_WAIT_MS))
        : 0;
    const batch = await this.registry.poll(rec.username, waitMs);
    if (batch.length > 0) console.log(batch);
    this.sendJson(res, 200, { in: batch });
  }

  private handlePrototypeDevice(body: Record<string, unknown>, res: ServerResponse): void {
    const { userId, deviceId, publicKeySpki } = body;
    if (typeof userId !== 'string' || typeof deviceId !== 'string' || typeof publicKeySpki !== 'string') {
      this.sendJson(res, 400, { ok: false, error: 'invalid_device' });
      return;
    }
    try {
      const directory = this.notes.registerDevice(userId, { deviceId, publicKeySpki });
      this.sendJson(res, 200, { ok: true, directory });
    } catch {
      this.sendJson(res, 400, { ok: false, error: 'invalid_device' });
    }
  }

  private async handlePrototypePairingStart(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const identity = await this.authGravity.verify(req.headers);
    const device = body.device;
    if (!identity || device === null || typeof device !== 'object') {
      this.sendJson(res, 401, { ok: false, error: 'auth' });
      return;
    }
    try {
      const pairing = this.pairing.start(identity.subject, device as { deviceId: string; publicKeySpki: string });
      this.sendJson(res, 201, { ok: true, pairing });
    } catch {
      this.sendJson(res, 400, { ok: false, error: 'invalid_pairing' });
    }
  }

  private handlePrototypePairingClaim(body: Record<string, unknown>, res: ServerResponse): void {
    const { code, device } = body;
    if (typeof code !== 'string' || device === null || typeof device !== 'object') {
      this.sendJson(res, 400, { ok: false, error: 'invalid_pairing' });
      return;
    }
    try {
      this.sendJson(res, 201, { ok: true, pairing: this.pairing.claim(code, device as { deviceId: string; publicKeySpki: string }) });
    } catch {
      this.sendJson(res, 400, { ok: false, error: 'invalid_pairing' });
    }
  }

  private async handlePrototypeNote(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const record = body.record;
    if (record === null || typeof record !== 'object') {
      this.sendJson(res, 400, { ok: false, error: 'invalid_note' });
      return;
    }
    try {
      await this.notes.send(record as EncryptedNoteRecordV1);
      this.sendJson(res, 202, { ok: true, id: (record as EncryptedNoteRecordV1).id });
    } catch {
      // Do not log a record: it contains opaque ciphertext and routing metadata.
      this.sendJson(res, 400, { ok: false, error: 'invalid_note' });
    }
  }

  private handlePrototypePoll(body: Record<string, unknown>, res: ServerResponse): void {
    if (typeof body.deviceId !== 'string') {
      this.sendJson(res, 400, { ok: false, error: 'invalid_device' });
      return;
    }
    try {
      this.sendJson(res, 200, { ok: true, records: this.notes.poll(body.deviceId) });
    } catch {
      this.sendJson(res, 404, { ok: false, error: 'unknown_device' });
    }
  }

  private handlePrototypeAck(body: Record<string, unknown>, res: ServerResponse): void {
    if (typeof body.deviceId !== 'string' || !Array.isArray(body.recordIds) || !body.recordIds.every((id) => typeof id === 'string')) {
      this.sendJson(res, 400, { ok: false, error: 'invalid_ack' });
      return;
    }
    try {
      this.sendJson(res, 200, { ok: true, acknowledged: this.notes.acknowledge(body.deviceId, body.recordIds) });
    } catch {
      this.sendJson(res, 404, { ok: false, error: 'unknown_device' });
    }
  }

  private handleSwapTestPage(body: Record<string, unknown>, res: ServerResponse): void {
    const to = body.to;
    if (typeof to !== 'string' || !isValidUsername(to)) {
      this.sendJson(res, 400, { ok: false, error: 'invalid_to' });
      return;
    }
    const elements = generateSwapTestPage();
    const env = this.router.routePageSend(SWAPTEST, { to, elements });
    this.log(`swaptest: page ${env.id} (strokes: ${elements.length}) -> ${to}`);
    this.sendJson(res, 200, { ok: true, to, pageId: env.id, elements: elements.length });
  }

  private auth(body: Record<string, unknown>): { username: string } | null {
    const username = body.username;
    const token = body.token;
    if (typeof username !== 'string' || typeof token !== 'string') return null;
    return this.registry.authenticate(username, token);
  }
}

export async function startWrtnServer(opts: WrtnServerOptions = {}): Promise<WrtnServer> {
  const server = new WrtnServer(opts);
  await server.listen({ host: opts.host ?? '0.0.0.0', port: opts.port ?? 8081 });
  return server;
}
