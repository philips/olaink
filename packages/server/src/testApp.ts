import type { AuthGravityVerifier } from './authGravity.ts';
import { buildCommit } from './buildInfo.ts';
import { OlainkApp } from './handler.ts';
import { MemoryNotePayloadStore } from './notePayloads.ts';
import { SqliteD1 } from './sqliteD1.ts';

/**
 * In-process harness for contract suites: a fresh in-memory database and
 * payload store behind the shared fetch handler, addressed by path.
 */
export interface TestApp {
  app: OlainkApp;
  fetch(path: string, init?: RequestInit, clientAddress?: string): Promise<Response>;
  close(): void;
}

export function createTestApp(options: { authGravity?: AuthGravityVerifier; now?: () => number } = {}): TestApp {
  const db = SqliteD1.open(':memory:');
  const app = new OlainkApp({
    db,
    payloads: new MemoryNotePayloadStore(),
    commit: buildCommit,
    authGravity: options.authGravity ?? { verify: async () => null },
    log: () => {},
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    app,
    fetch: (path, init, clientAddress = '127.0.0.1') => app.fetch(new Request(`http://localhost${path}`, init), clientAddress),
    close: () => db.close(),
  };
}
