import { applyD1Migrations, env } from 'cloudflare:test';

// The Workers project applies migrations/*.sql with Cloudflare's own runner
// (the one `wrangler d1 migrations apply` mirrors), independently of the
// standalone binary's SqliteD1 runner. Idempotent per test file.
await applyD1Migrations(env.db, env.TEST_MIGRATIONS);
