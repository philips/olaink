// Builds the self-contained olaink-server binary with the deploy commit
// baked in as process.env.OLAINK_BUILD_COMMIT (consumed by
// packages/server/src/buildInfo.ts via bun --define). This replaces the old
// embed-script step that regenerated buildInfo.ts as a committed file — a
// file that could never stably contain the hash of the commit it ships in.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const arm64 = process.argv.includes('--arm64');
const outfile = arm64 ? 'dist/olaink-server-linux-arm64' : 'dist/olaink-server';

const candidate = process.env.OLAINK_BUILD_COMMIT
  ?? process.env.GITHUB_SHA
  ?? (() => {
    try { return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', cwd: root }).trim(); }
    catch { return 'unknown'; }
  })();
const commit = /^[0-9a-f]{40}$/i.test(candidate) ? candidate.toLowerCase() : 'unknown';

const embed = spawnSync('node', ['scripts/embed-onboard-page.mjs'], { cwd: root, stdio: 'inherit' });
if (embed.status !== 0) process.exit(embed.status ?? 1);

mkdirSync(new URL('dist/', `file://${root}/`), { recursive: true });
const build = spawnSync('bun', [
  'build', 'packages/server/src/main.ts',
  '--compile',
  ...(arm64 ? ['--target', 'bun-linux-arm64'] : []),
  `--outfile=${outfile}`,
  // The define replaces the env read in buildInfo.ts with a string literal,
  // so the compiled binary reports its exact source commit via /commit.
  `--define=process.env.OLAINK_BUILD_COMMIT:${JSON.stringify(commit)}`,
], { cwd: root, stdio: 'inherit' });
process.exit(build.status ?? 1);
