import { createRequire } from 'node:module';
import type { D1DatabaseLike, D1PreparedStatement, D1Result } from './d1Store.ts';
import { migrations as bundledMigrations, type Migration } from './migrations.ts';

/**
 * D1-API shim over a local SQLite file for the standalone binary and the test
 * suite. Only the surface D1Store and D1PairingClaimLimiter use is
 * implemented, with D1's result shapes: run()/batch() report `meta.changes`,
 * first() returns null for no row, batch() is one transaction. Foreign keys
 * are enforced, as they always are on D1.
 *
 * Bun's built-in binding serves the compiled binary; Node 22's node:sqlite
 * serves the Vitest environment.
 */
type Row = Record<string, unknown>;
type RawStatement = {
  all(...values: unknown[]): Row[];
  run(...values: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
};
type RawDatabase = {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
};

const require = createRequire(import.meta.url);

function openRaw(path: string): RawDatabase {
  try {
    const { Database } = require('bun:sqlite') as {
      Database: new (filename: string, options?: { strict?: boolean }) => {
        exec(sql: string): void;
        prepare(sql: string): {
          all(...values: unknown[]): Row[];
          run(...values: unknown[]): { changes: number; lastInsertRowid: number | bigint };
        };
        close(): void;
      };
    };
    return new Database(path, { strict: true });
  } catch {
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (filename: string) => RawDatabase };
    return new DatabaseSync(path);
  }
}

class SqlitePreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly db: SqliteD1,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): D1PreparedStatement {
    for (const value of params) {
      // D1 rejects undefined bindings; surface the same mistake locally.
      if (value === undefined) throw new Error('D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\'');
    }
    return new SqlitePreparedStatement(this.db, this.sql, params);
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    return this.db.execute(this) as D1Result<T>;
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.db.execute(this).results[0];
    if (!row) return null;
    return (column === undefined ? row : row[column] ?? null) as T | null;
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    return this.db.execute(this) as D1Result<T>;
  }
}

export class SqliteD1 implements D1DatabaseLike {
  private readonly raw: RawDatabase;
  private readonly cache = new Map<string, RawStatement>();

  private constructor(path: string) {
    this.raw = openRaw(path);
    this.raw.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
  }

  /** Opens (or creates) the database and applies pending migrations in order. */
  static open(path: string, migrations: readonly Migration[] = bundledMigrations): SqliteD1 {
    if (!path) throw new Error('database path is required');
    const db = new SqliteD1(path);
    db.migrate(migrations);
    return db;
  }

  prepare(sql: string): D1PreparedStatement {
    return new SqlitePreparedStatement(this, sql);
  }

  async batch<T = Row>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => this.execute(statement as SqlitePreparedStatement));
      this.raw.exec('COMMIT');
      return results as D1Result<T>[];
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }

  /** @internal Runs one statement synchronously with D1's result shape. */
  execute(statement: SqlitePreparedStatement): D1Result<Row> {
    let raw = this.cache.get(statement.sql);
    if (!raw) {
      raw = this.raw.prepare(statement.sql);
      this.cache.set(statement.sql, raw);
    }
    // Reads and RETURNING statements produce rows; everything else reports
    // its change count. Both drivers expose this via the statement's
    // column count only indirectly, so dispatch on the SQL itself.
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(statement.sql) || /\bRETURNING\b/i.test(statement.sql)) {
      const results = raw.all(...statement.params);
      return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
    }
    const info = raw.run(...statement.params);
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) },
    };
  }

  /**
   * Applies migrations not yet recorded in d1_migrations, the same tracking
   * table `wrangler d1 migrations apply` maintains, so a database is never
   * migrated twice by either tool.
   */
  private migrate(migrations: readonly Migration[]): void {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`);
    const applied = new Set(this.raw.prepare('SELECT name FROM d1_migrations').all().map((row) => row['name']));
    for (const migration of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
      if (applied.has(migration.name)) continue;
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        this.raw.exec(migration.sql);
        this.raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(migration.name);
        this.raw.exec('COMMIT');
      } catch (error) {
        this.raw.exec('ROLLBACK');
        throw error;
      }
    }
  }
}
