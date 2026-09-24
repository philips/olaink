/**
 * Standalone CLI entrypoint (compiled to the self-host binary):
 * olaink-server [--port N] [--host H] [--database FILE] [--notes DIR]
 * olaink-server --retention-sweep-once [--database FILE] [--notes DIR]
 */

import { buildCommit } from './buildInfo.ts';
import { runRetentionSweepOnce, startStandalone } from './standalone.ts';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]!;
  return undefined;
}

const databasePath = arg('database') ?? process.env['OLAINK_DATABASE'] ?? './olaink.sqlite';
const notesPath = arg('notes') ?? process.env['OLAINK_NOTES_DIR'];

// One-shot mode for operators who prefer an external cron/systemd timer over
// the server's built-in retention interval: run one sweep and exit, no HTTP
// listener. See plans/message-retention.md.
if (process.argv.includes('--retention-sweep-once')) {
  const purged = await runRetentionSweepOnce({ databasePath, commit: buildCommit, ...(notesPath ? { notesPath } : {}) });
  console.log(`[olaink-server] retention sweep purged ${purged} note(s)`);
  process.exit(0);
}

const port = Number(arg('port') ?? process.env['OLAINK_PORT'] ?? 8002);
const host = arg('host') ?? process.env['OLAINK_HOST'] ?? '0.0.0.0';

const server = startStandalone({ host, port, databasePath, commit: buildCommit, ...(notesPath ? { notesPath } : {}) });
console.log(`[olaink-server] listening on http://${server.hostname}:${server.port}`);
console.log(
  '[olaink-server] encrypted inbox: POST /v1/devices /notes /poll /ack; GET /v1/users/:username',
);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[olaink-server] ${signal}: shutting down`);
    void server.stop().then(() => process.exit(0));
  });
}
