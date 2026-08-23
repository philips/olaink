/**
 * HTTP shell over Registry+Router.
 *
 *   POST /v1/hello { username, deviceType, client }
 *     -> 200 { ok, username, token } | 400 { ok:false, error }
 *   POST /v1/send  { username, token, msgs: Envelope[] }
 *     -> 200 { ok:true } | 401 { ok:false, error:'auth' }
 *   POST /v1/poll  { username, token, waitMs }
 *     -> 200 { in: Envelope[] } | 401 { ok:false, error:'auth' }
 *   GET  /healthz  -> 200 'ok'
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isValidUsername } from '@wrtn/protocol';
import type { Envelope } from '@wrtn/protocol';
import { Registry } from './registry.ts';
import { Router } from './router.ts';
import { SWAPTEST } from './registry.ts';
import { generateSwapTestPage } from './swapTest.ts';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_WAIT_MS = 25_000;

export interface WrtnServerOptions {
  host?: string;
  port?: number;
  now?: () => number;
}

export class WrtnServer {
  public readonly registry: Registry;
  public readonly router: Router;
  private readonly http: Server;

  constructor(opts: WrtnServerOptions = {}) {
    this.registry = new Registry(opts.now);
    this.router = new Router({ registry: this.registry });

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
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
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

    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // Debug: who is connected (E2E observability).
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
