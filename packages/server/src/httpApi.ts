/**
 * node:http shell over the fetch-style handler (handler.ts), kept for the
 * current CLI entry and the HTTP-level test suites until the standalone
 * Bun.serve entry replaces it. Routing and response semantics live entirely
 * in OlainkApp.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { buildCommit } from './buildInfo.ts';
import { OlainkApp } from './handler.ts';
import type { D1Store } from './d1Store.ts';
import type { PrototypeNoteRelay } from './prototypeNoteRelay.ts';
import type { PrototypePairingService } from './prototypePairing.ts';
import { SqliteD1 } from './sqliteD1.ts';
import { MemoryNotePayloadStore, type NotePayloadStore } from './notePayloads.ts';
import { DirectoryNotePayloads } from './localNotePayloads.ts';
import { AuthGravityWhoAmIVerifier, type AuthGravityVerifier } from './authGravity.ts';

export interface OlainkServerOptions {
  host?: string;
  port?: number;
  now?: () => number;
  /** Injected in tests; production uses AUTHGRAVITY_WHOAMI_URL. */
  authGravity?: AuthGravityVerifier;
  /** Required SQLite file; use ':memory:' only for isolated SQLite tests. */
  databasePath?: string;
  /**
   * Directory for encrypted note payloads (the local stand-in for R2).
   * Defaults to `<databasePath>-notes`; a ':memory:' database keeps payloads
   * in memory too.
   */
  notesPath?: string;
}

export class OlainkServer {
  public readonly app: OlainkApp;
  private readonly db: SqliteD1;
  private readonly http: Server;

  constructor(opts: OlainkServerOptions = {}) {
    if (!opts.databasePath) throw new Error('databasePath is required');
    this.db = SqliteD1.open(opts.databasePath);
    const payloads: NotePayloadStore = !opts.notesPath && opts.databasePath === ':memory:'
      ? new MemoryNotePayloadStore()
      : new DirectoryNotePayloads(opts.notesPath ?? `${opts.databasePath}-notes`);
    this.app = new OlainkApp({
      db: this.db,
      payloads,
      authGravity: opts.authGravity ?? new AuthGravityWhoAmIVerifier(),
      commit: buildCommit,
      log: (...args) => this.log(...args),
      ...(opts.now ? { now: opts.now } : {}),
    });

    this.http = createServer((req, res) => {
      void this.serve(req, res).catch((err) => {
        this.log('request error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'internal' }));
        } else res.end();
      });
    });
  }

  get store(): D1Store { return this.app.store; }
  get notes(): PrototypeNoteRelay { return this.app.notes; }
  get pairing(): PrototypePairingService { return this.app.pairing; }

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
      this.db.close();
      resolve();
    }));
  }

  private log(...args: unknown[]): void {
    console.log('[olaink-server]', ...args);
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    }
    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const request = new Request(new URL(req.url ?? '/', 'http://localhost'), {
      method,
      headers,
      ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
    } as RequestInit);
    const response = await this.app.fetch(request, req.socket.remoteAddress ?? 'unknown');
    const body = new Uint8Array(await response.arrayBuffer());
    const outgoing: Record<string, string> = {};
    response.headers.forEach((value, name) => { outgoing[name] = value; });
    if (response.status !== 204) outgoing['content-length'] = String(body.byteLength);
    res.writeHead(response.status, outgoing);
    res.end(body);
  }
}

export async function startOlainkServer(opts: OlainkServerOptions): Promise<OlainkServer> {
  const server = new OlainkServer(opts);
  await server.listen({ host: opts.host ?? '0.0.0.0', port: opts.port ?? 8002 });
  return server;
}
