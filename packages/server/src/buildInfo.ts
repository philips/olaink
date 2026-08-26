// Deploy builds bake OLAINK_BUILD_COMMIT into this module via bun --define
// (scripts/build-server.mjs); there is deliberately no generated copy to
// commit, because a file cannot contain the hash of the commit it ships in.
// Unbuilt dev/test runs fall back to this checkout's HEAD, then 'unknown'.
import { execFileSync } from 'node:child_process';

function isCommit(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

function localCommit(): string {
  try {
    const candidate = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return isCommit(candidate) ? candidate.toLowerCase() : 'unknown';
  } catch {
    return 'unknown';
  }
}

const baked = process.env.OLAINK_BUILD_COMMIT;
export const buildCommit = isCommit(baked) ? baked.toLowerCase() : localCommit();
