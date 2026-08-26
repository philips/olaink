import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { olaInkHeader, olaInkNavLink, olaInkNavLogoutButton } from '../packages/ui/src/templates.mjs';

const source = new URL('../packages/server/public/onboard.html', import.meta.url);
const target = new URL('../packages/server/src/onboardPage.ts', import.meta.url);
const viewerSource = new URL('../android/app/src/main/assets/supernote-viewer.js', import.meta.url);
const viewerTarget = new URL('../packages/server/src/viewerAsset.ts', import.meta.url);
const buildInfoTarget = new URL('../packages/server/src/buildInfo.ts', import.meta.url);
const brandTarget = new URL('../packages/server/src/brandAsset.ts', import.meta.url);
const sharedStylesSource = new URL('../packages/ui/src/olaink.css', import.meta.url);
const brandSource = new URL('../packages/site/public/olaink-logo.svg', import.meta.url);
const sharedStyles = await readFile(sharedStylesSource, 'utf8');
const brandAsset = await readFile(brandSource, 'utf8');
const header = olaInkHeader({
  homeHref: '/',
  logoSrc: '/olaink-logo.svg',
  navigation: olaInkNavLink({ href: 'https://olaink.com/install/', label: 'Install' }) + olaInkNavLogoutButton(),
});
const html = (await readFile(source, 'utf8'))
  .replace('__OLAINK_SHARED_CSS__', sharedStyles)
  .replace('__OLAINK_HEADER__', header);
const viewer = await readFile(viewerSource, 'utf8');
const candidate = process.env.OLAINK_BUILD_COMMIT
  ?? process.env.GITHUB_SHA
  ?? (() => { try { return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
const buildCommit = /^[0-9a-f]{40}$/i.test(candidate) ? candidate.toLowerCase() : 'unknown';
await writeFile(target, `// Generated from ../public/onboard.html for the self-contained Bun binary.\nexport const onboardPage = ${JSON.stringify(html)};\n`);
await writeFile(viewerTarget, `// Generated from Android's pinned viewer asset for the self-contained Bun binary.\nexport const viewerAsset = ${JSON.stringify(viewer)};\n`);
await writeFile(buildInfoTarget, `// Generated at build time; do not edit.\nexport const buildCommit = ${JSON.stringify(buildCommit)};\n`);
await writeFile(brandTarget, `// Generated from the shared Ola Ink brand asset; do not edit.\nexport const brandAsset = ${JSON.stringify(brandAsset)};\n`);
