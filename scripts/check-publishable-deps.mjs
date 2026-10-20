#!/usr/bin/env node
// Refuses a release when a package depends on something the npm registry cannot
// resolve, which npm publish does not check: a workspace-only package or an
// unpublished version installs fine in this repo and fails for every consumer.
//
//   node scripts/check-publishable-deps.mjs packages/pi-plugin
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: check-publishable-deps.mjs <package-dir>');
  process.exit(2);
}
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const groups = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const unresolved = [];
for (const group of groups) {
  for (const [name, range] of Object.entries(pkg[group] ?? {})) {
    // Registry-only specs are checked; file:, link:, git and workspace specs are not publishable at all.
    const spec = `${name}@${range}`;
    let found = '';
    try {
      found = execFileSync('npm', ['view', spec, 'version', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      found = '';
    }
    if (!found) {
      unresolved.push(`${group}: ${spec}`);
    }
  }
}
if (unresolved.length > 0) {
  console.error(`${pkg.name}@${pkg.version} cannot be published: the npm registry has no match for\n  ${unresolved.join('\n  ')}`);
  console.error('Publish those first (or depend on a published version), then re-tag.');
  process.exit(1);
}
console.log(`${pkg.name}@${pkg.version}: all dependencies resolve on the npm registry.`);
