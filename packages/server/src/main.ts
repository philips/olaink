/** CLI entrypoint: wrtn-server [--port N] [--host H] */

import { startWrtnServer } from './httpApi.ts';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]!;
  return undefined;
}

const port = Number(arg('port') ?? process.env['WRTN_PORT'] ?? 8081);
const host = arg('host') ?? process.env['WRTN_HOST'] ?? '0.0.0.0';

const server = await startWrtnServer({ host, port });
const addr = server.address();
console.log(`[wrtn-server] listening on http://${addr?.host ?? host}:${addr?.port ?? port}`);
console.log(
  '[wrtn-server] endpoints: POST /v1/hello /v1/send /v1/poll /v1/test/swaptest/page, GET /healthz /v1/peers',
);
