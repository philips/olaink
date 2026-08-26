import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { olaInkHeader, olaInkNavLink, olaInkNavLogoutButton } from '../packages/ui/src/templates.mjs';

// --check regenerates in memory and fails if any committed generated file is
// stale, so a PR cannot merge with sources (onboard.html, its Preact client,
// the pinned viewer asset, shared CSS/templates) that disagree with their embedded copies.
const checkOnly = process.argv.includes('--check');

const source = new URL('../packages/server/public/onboard.html', import.meta.url);
const clientSource = new URL('../packages/server/src/onboardClient.tsx', import.meta.url);
const viewerSource = new URL('../android/app/src/main/assets/supernote-viewer.js', import.meta.url);
const outputs = [
  {
    name: 'packages/server/src/onboardPage.ts',
    url: new URL('../packages/server/src/onboardPage.ts', import.meta.url),
    render: (html) => `// Generated from ../public/onboard.html for the self-contained Bun binary.\nexport const onboardPage = ${JSON.stringify(html)};\n`,
  },
  {
    name: 'packages/server/src/viewerAsset.ts',
    url: new URL('../packages/server/src/viewerAsset.ts', import.meta.url),
    render: (viewer) => `// Generated from Android's pinned viewer asset for the self-contained Bun binary.\nexport const viewerAsset = ${JSON.stringify(viewer)};\n`,
  },
  {
    name: 'packages/server/src/brandAsset.ts',
    url: new URL('../packages/server/src/brandAsset.ts', import.meta.url),
    render: (brandAsset) => `// Generated from the shared Ola Ink brand asset; do not edit.\nexport const brandAsset = ${JSON.stringify(brandAsset)};\n`,
  },
];

const sharedStyles = await readFile(new URL('../packages/ui/src/olaink.css', import.meta.url), 'utf8');
const brandAsset = await readFile(new URL('../packages/site/public/olaink-logo.svg', import.meta.url), 'utf8');
const header = olaInkHeader({
  homeHref: '/',
  logoSrc: '/olaink-logo.svg',
  navigation: olaInkNavLink({ href: 'https://olaink.com/install/', label: 'Install' }) + '<button id="workspace-menu" type="button" aria-expanded="false" aria-controls="workspace-nav" hidden><span class="hamburger" aria-hidden="true">☰</span> Menu</button>' + olaInkNavLogoutButton(),
});
const clientBuild = await build({
  entryPoints: [clientSource.pathname],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  write: false,
});
const client = clientBuild.outputFiles[0].text.replaceAll('</script', '<\\/script');
const html = (await readFile(source, 'utf8'))
  .replace('__OLAINK_SHARED_CSS__', sharedStyles)
  .replace('__OLAINK_HEADER__', header)
  .replace('__OLAINK_APP__', client);
const viewer = await readFile(viewerSource, 'utf8');
const inputs = {
  'packages/server/src/onboardPage.ts': html,
  'packages/server/src/viewerAsset.ts': viewer,
  'packages/server/src/brandAsset.ts': brandAsset,
};

const stale = [];
for (const output of outputs) {
  const generated = output.render(inputs[output.name]);
  const current = await readFile(output.url, 'utf8');
  if (generated === current) continue;
  stale.push(output.name);
  if (!checkOnly) await writeFile(output.url, generated);
}

if (checkOnly) {
  if (stale.length > 0) {
    console.error(`Stale generated files (run: node scripts/embed-onboard-page.mjs):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log('Generated files are up to date.');
}
