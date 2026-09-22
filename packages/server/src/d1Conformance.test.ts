import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './testApp.ts';

// The D1 API subset D1Store and the rate limiter rely on. Runs against the
// SqliteD1 shim (node project) and real D1 in Miniflare (workers project), so
// the shim cannot drift from production semantics unnoticed.
let harness: TestApp;

beforeEach(async () => { harness = await createTestApp(); });
afterEach(() => harness.close());

describe('D1 API conformance', () => {
  it('matches the result shapes the store relies on', async () => {
    const db = harness.db;
    expect(await db.prepare('SELECT user_id FROM prototype_accounts WHERE subject = ?').bind('none').first())
      .toBeNull();
    const inserted = await db.prepare('INSERT INTO prototype_accounts (subject, user_id, created_at) VALUES (?, ?, ?)')
      .bind('subject', 'account_one', 1).run();
    expect(inserted.meta.changes).toBe(1);
    expect(await db.prepare('SELECT user_id FROM prototype_accounts WHERE subject = ?').bind('subject')
      .first('user_id')).toBe('account_one');
    expect(await db.prepare('SELECT user_id FROM prototype_accounts WHERE subject = ?').bind('none')
      .first('user_id')).toBeNull();
    expect((await db.prepare('SELECT subject, created_at FROM prototype_accounts').all()).results)
      .toEqual([{ subject: 'subject', created_at: 1 }]);
    const [ignored, read] = await db.batch([
      db.prepare('INSERT OR IGNORE INTO prototype_accounts (subject, user_id, created_at) VALUES (?, ?, ?)')
        .bind('subject', 'account_one', 2),
      db.prepare('SELECT COUNT(*) AS count FROM prototype_accounts'),
    ]);
    expect(ignored!.meta.changes).toBe(0);
    expect(read!.results).toEqual([{ count: 1 }]);
    expect((await db.prepare('DELETE FROM prototype_accounts WHERE subject = ?').bind('nobody').run()).meta.changes).toBe(0);
  });

  it('rolls back a whole batch on failure and reports UNIQUE / FOREIGN KEY violations by message', async () => {
    const db = harness.db;
    await expect(db.batch([
      db.prepare('INSERT INTO prototype_accounts (subject, user_id, created_at) VALUES (?, ?, ?)').bind('a', 'account_a', 1),
      db.prepare('INSERT INTO prototype_accounts (subject, user_id, created_at) VALUES (?, ?, ?)').bind('b', 'account_a', 1),
    ])).rejects.toThrow('UNIQUE constraint failed');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM prototype_accounts').first('count')).toBe(0);
    await expect(db.prepare('INSERT INTO prototype_devices (device_id, user_id, public_key_spki, created_at) VALUES (?, ?, ?, ?)')
      .bind('device', 'no-directory', 'key', 1).run()).rejects.toThrow('FOREIGN KEY constraint failed');
  });

  it('cascades deletes through foreign keys', async () => {
    const db = harness.db;
    await db.batch([
      db.prepare('INSERT INTO prototype_directories (user_id, version) VALUES (?, 1)').bind('u'),
      db.prepare('INSERT INTO prototype_devices (device_id, user_id, public_key_spki, created_at) VALUES (?, ?, ?, ?)')
        .bind('d', 'u', 'key', 1),
      db.prepare('INSERT INTO prototype_device_sessions (token_hash, device_id, created_at) VALUES (?, ?, ?)').bind('h', 'd', 1),
    ]);
    await db.prepare('DELETE FROM prototype_devices WHERE device_id = ?').bind('d').run();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM prototype_device_sessions').first('count')).toBe(0);
  });

  it('rejects undefined bindings', async () => {
    const db = harness.db;
    // D1 throws at bind() (the shim) or at execution; either way nothing runs.
    await expect((async () => db.prepare('SELECT ? AS value').bind(undefined).first())()).rejects.toThrow();
  });
});
