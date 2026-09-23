import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const server = (path: string) => fileURLToPath(new URL(`./packages/server/${path}`, import.meta.url));

// Suites that exercise the service through createTestApp or runtime-agnostic
// code. They run twice: under Node against the standalone path (SQLite D1
// shim), and inside workerd against Miniflare D1 + R2 — the production path.
const portableServerSuites = [
  'accountApi', 'accountUsernames', 'bytes', 'd1Conformance', 'handler', 'prototypeNoteApi', 'prototypeNoteRelay',
  'prototypePairing', 'routes', 'webCryptoInterop',
].map((name) => `packages/server/src/${name}.test.ts`);

export default defineConfig(async () => {
  const migrations = await readD1Migrations(server('migrations'));
  return {
    test: {
      watch: false,
      projects: [
        {
          test: {
            name: 'node',
            include: ['packages/*/src/**/*.test.ts', 'packages/pi-plugin/*.test.ts'],
            // Workers-only: needs the cloudflare:workers module.
            exclude: ['packages/server/src/worker.test.ts'],
            environment: 'node',
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: server('wrangler.jsonc') },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          resolve: {
            // Swap the harness for the D1/R2-backed one.
            alias: [{ find: /^\.\/testApp\.ts$/, replacement: server('src/testApp.workers.ts') }],
          },
          test: {
            name: 'workers',
            include: [...portableServerSuites, 'packages/server/src/worker.test.ts'],
            setupFiles: [server('src/workersSetup.ts')],
            // The D1/R2 bindings are shared; harnesses empty them on creation.
            fileParallelism: false,
          },
        },
      ],
    },
  };
});
