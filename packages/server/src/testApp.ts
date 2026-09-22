import { MemoryNotePayloadStore } from './notePayloads.ts';
import { SqliteD1 } from './sqliteD1.ts';
import { harness, type TestApp, type TestAppOptions } from './testHarness.ts';

export type { TestApp, TestAppOptions } from './testHarness.ts';

/**
 * In-process harness for the contract suites: fresh, empty relay state behind
 * the shared fetch handler, addressed by path. This is the Node/standalone
 * variant (SQLite D1 shim + in-memory payloads); the Workers test project
 * aliases this module to testApp.workers.ts (Miniflare D1 + R2), so every
 * suite that uses it runs against both backends unchanged.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const db = SqliteD1.open(':memory:');
  return harness(db, new MemoryNotePayloadStore(), options, async () => db.close());
}
