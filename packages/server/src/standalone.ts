/**
 * Standalone (self-host) server: the same OlainkApp the Worker runs, served by
 * Bun.serve over the SQLite D1 shim and a local payload directory. No
 * Cloudflare account and no runtime beyond the compiled bun binary.
 */
import { AuthGravityWhoAmIVerifier, type AuthGravityVerifier } from './authGravity.ts';
import { OlainkApp } from './handler.ts';
import { DirectoryNotePayloads } from './localNotePayloads.ts';
import { MemoryNotePayloadStore, type NotePayloadStore } from './notePayloads.ts';
import { SqliteD1 } from './sqliteD1.ts';

/** Structural slice of Bun's server API (the repo does not depend on bun-types). */
interface BunServer {
  readonly port: number;
  readonly hostname: string;
  requestIP(request: Request): { address: string } | null;
  stop(closeActiveConnections?: boolean): Promise<void> | void;
}
declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request, server: BunServer): Promise<Response>;
  }): BunServer;
};

export interface StandaloneOptions {
  host?: string;
  port?: number;
  /** Required SQLite file; ':memory:' only for isolated tests. */
  databasePath: string;
  /**
   * Directory for encrypted note payloads (the local stand-in for R2).
   * Defaults to `<databasePath>-notes`; a ':memory:' database keeps payloads
   * in memory too.
   */
  notesPath?: string;
  /** Build commit served at /commit. */
  commit: string;
  /** Injected in tests; production uses AUTHGRAVITY_WHOAMI_URL. */
  authGravity?: AuthGravityVerifier;
  now?: () => number;
}

export interface StandaloneServer {
  readonly app: OlainkApp;
  readonly hostname: string;
  readonly port: number;
  /** Stops accepting requests, closes open connections, then the database. */
  stop(): Promise<void>;
}

export function startStandalone(options: StandaloneOptions): StandaloneServer {
  if (!options.databasePath) throw new Error('databasePath is required');
  const db = SqliteD1.open(options.databasePath);
  const payloads: NotePayloadStore = !options.notesPath && options.databasePath === ':memory:'
    ? new MemoryNotePayloadStore()
    : new DirectoryNotePayloads(options.notesPath ?? `${options.databasePath}-notes`);
  const app = new OlainkApp({
    db,
    payloads,
    commit: options.commit,
    authGravity: options.authGravity ?? new AuthGravityWhoAmIVerifier(),
    ...(options.now ? { now: options.now } : {}),
  });
  const server = Bun.serve({
    hostname: options.host ?? '0.0.0.0',
    port: options.port ?? 8002,
    // The socket address keys the pairing-claim rate limit, as in the old
    // node:http server. Behind a reverse proxy every client shares the
    // proxy's address; keep an edge rate limit there.
    fetch: (request, bun) => app.fetch(request, bun.requestIP(request)?.address ?? 'unknown'),
  });
  return {
    app,
    hostname: server.hostname,
    port: server.port,
    async stop() {
      await server.stop(true);
      db.close();
    },
  };
}
