/**
 * Module-scope WRTN session singleton.
 *
 * Started unconditionally when the plugin runtime boots (index.js), so the
 * headless toolbar button works even if the RN view is never mounted —
 * per AGENTS.md, closePluginView() stops the runtime, so a long-running
 * session needs the showType:0 button entry point.
 */

import { HttpPollTransport } from '@wrtn/protocol';
import { NoteStore, STORE_NOTE_PATHS } from './core/noteStore.ts';
import { WrtnCore } from './core/wrtnCore.ts';
import { createSnDeviceBridge } from './device/snDevice.ts';

/** Tailscale Serve HTTPS endpoint (PluginHost blocks cleartext HTTP) → local :8001. */
export const DEFAULT_SERVER_URL = 'https://macmini.rhino-dragon.ts.net';

/** Config note lives under /MyStyle — absolute paths, see noteStore.ts. */

let core: WrtnCore | null = null;

export function getCore(): WrtnCore {
  if (core !== null) return core;
  const bridge = createSnDeviceBridge();
  const transport = new HttpPollTransport({
    baseUrl: DEFAULT_SERVER_URL,
    username: '',
    deviceType: 4, // A6X2 Nomad
    client: 'wrtn-plugin/0.1.0',
    waitMs: 20_000,
    initialBackoffMs: 500,
    requestTimeoutMs: 35_000,
  });
  core = new WrtnCore({
    bridge,
    transport,
    store: new NoteStore(bridge, STORE_NOTE_PATHS),
    defaultServerUrl: DEFAULT_SERVER_URL,
  });
  return core;
}

/** Idempotent session start. Safe to call from index.js and from App. */
export async function startSession(): Promise<void> {
  const c = getCore();
  if (c.state.phase !== 'starting') return;
  try {
    await c.start();
  } catch (err) {
    console.log(`[wrtn] session start failed: ${(err as Error).message}`);
  }
}
