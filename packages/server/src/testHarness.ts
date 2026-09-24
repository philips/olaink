import type { AuthGravityVerifier } from './authGravity.ts';
import type { D1DatabaseLike } from './d1Store.ts';
import { OlainkApp } from './handler.ts';
import type { NotePayloadStore } from './notePayloads.ts';

/** Shared by both createTestApp variants (testApp.ts, testApp.workers.ts). */
export interface TestAppOptions {
  authGravity?: AuthGravityVerifier;
  now?: () => number;
  commit?: string;
  noteRetentionMs?: number;
}

export interface TestApp {
  app: OlainkApp;
  db: D1DatabaseLike;
  fetch(path: string, init?: RequestInit, clientAddress?: string): Promise<Response>;
  close(): Promise<void>;
}

export function harness(
  db: D1DatabaseLike,
  payloads: NotePayloadStore,
  options: TestAppOptions,
  close: () => Promise<void>,
): TestApp {
  const app = new OlainkApp({
    db,
    payloads,
    commit: options.commit ?? 'unknown',
    authGravity: options.authGravity ?? { verify: async () => null },
    log: () => {},
    ...(options.now ? { now: options.now } : {}),
    ...(options.noteRetentionMs !== undefined ? { noteRetentionMs: options.noteRetentionMs } : {}),
  });
  return {
    app,
    db,
    fetch: (path, init, clientAddress = '127.0.0.1') => app.fetch(new Request(`http://localhost${path}`, init), clientAddress),
    close,
  };
}
