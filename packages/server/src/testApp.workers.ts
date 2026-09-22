import { env } from 'cloudflare:test';
import { R2NotePayloads } from './notePayloads.ts';
import { harness, type TestApp, type TestAppOptions } from './testHarness.ts';

export type { TestApp, TestAppOptions } from './testHarness.ts';

/**
 * Workers-runtime variant of createTestApp (aliased in for the `workers`
 * vitest project): the real Miniflare D1 and R2 bindings from wrangler.jsonc.
 * The bindings are shared by every harness in the run, so each harness starts
 * by emptying them; the project runs files serially (fileParallelism: false).
 */
const TABLES = [
  // Children before parents (foreign keys are enforced on D1).
  'prototype_device_sessions',
  'prototype_note_deliveries',
  'prototype_notes',
  'prototype_pairings',
  'prototype_devices',
  'prototype_directories',
  'prototype_accounts',
  'account_usernames',
  'pairing_claim_buckets',
];

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  await env.db.batch(TABLES.map((table) => env.db.prepare(`DELETE FROM ${table}`)));
  let cursor: string | undefined;
  do {
    const page: { objects: { key: string }[]; truncated: boolean; cursor?: string } =
      await env.notes.list(cursor ? { cursor } : undefined);
    await Promise.all(page.objects.map((object) => env.notes.delete(object.key)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return harness(env.db, new R2NotePayloads(env.notes), options, async () => {});
}
