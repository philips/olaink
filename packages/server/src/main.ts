/** CLI entrypoint: olaink-server [--port N] [--host H] */

import { startOlainkServer } from './httpApi.ts';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]!;
  return undefined;
}

const port = Number(arg('port') ?? process.env['OLAINK_PORT'] ?? 8002);
const host = arg('host') ?? process.env['OLAINK_HOST'] ?? '0.0.0.0';
const databasePath = arg('database') ?? process.env['OLAINK_DATABASE'] ?? './olaink.sqlite';

const server = await startOlainkServer({ host, port, databasePath });
const addr = server.address();
console.log(`[olaink-server] listening on http://${addr?.host ?? host}:${addr?.port ?? port}`);
console.log(
  '[olaink-server] encrypted inbox: POST /v1/devices /notes /poll /ack; GET /v1/users/:username',
);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[olaink-server] ${signal}: shutting down`);
    void server.close().then(() => process.exit(0));
  });
}
