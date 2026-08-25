/**
 * Module-scope SwapNote delivery singleton.
 *
 * Started unconditionally when the plugin runtime boots (index.js), so the
 * headless toolbar button works even if the RN view is never mounted —
 * per AGENTS.md, closePluginView() stops the runtime, so a long-running
 * delivery needs the showType:0 button entry point.
 */

import { HttpPollTransport } from '@olaink/protocol';
import { NoteStore, STORE_NOTE_PATHS } from './core/noteStore.ts';
import { OlainkCore } from './core/olainkCore.ts';
import { createSnDeviceBridge } from './device/snDevice.ts';

/** Tailscale Serve HTTPS endpoint (PluginHost blocks cleartext HTTP) → local :8001. */
export const DEFAULT_SERVER_URL = 'https://macmini.rhino-dragon.ts.net';

/** Config note lives under /MyStyle — absolute paths, see noteStore.ts. */

let core: OlainkCore | null = null;

export function getCore(): OlainkCore {
  if (core !== null) return core;
  const bridge = createSnDeviceBridge();
  const transport = new HttpPollTransport({
    baseUrl: DEFAULT_SERVER_URL,
    username: '',
    deviceType: 4, // A6X2 Nomad
    client: 'olaink-plugin/0.1.0',
    waitMs: 20_000,
    initialBackoffMs: 500,
    requestTimeoutMs: 35_000,
  });
  core = new OlainkCore({
    bridge,
    transport,
    store: new NoteStore(bridge, STORE_NOTE_PATHS),
    defaultServerUrl: DEFAULT_SERVER_URL,
  });
  return core;
}

/** Idempotent delivery start. Safe to call from index.js and from App. */
export async function startSwapNote(): Promise<void> {
  const c = getCore();
  if (c.state.phase !== 'starting') return;
  try {
    await c.start();
  } catch (err) {
    console.log(`[olaink] SwapNote start failed: ${(err as Error).message}`);
  }
}
