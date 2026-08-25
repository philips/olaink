import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../packages/server/public/onboard.html', import.meta.url);
const target = new URL('../packages/server/src/onboardPage.ts', import.meta.url);
const html = await readFile(source, 'utf8');
await writeFile(target, `// Generated from ../public/onboard.html for the self-contained Bun binary.\nexport const onboardPage = ${JSON.stringify(html)};\n`);
