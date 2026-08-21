/**
 * Transport-agnostic interface. v1 ships HttpPollTransport (fetch-based,
 * proven on-device). A WebSocket adapter can be added later behind the same
 * interface once validated in the PluginHost runtime.
 */

import type { Envelope } from '../envelope.ts';

export type TransportState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'backoff'
  | 'closed';

export interface TransportStats {
  sent: number;
  received: number;
  polls: number;
  lastError: string | null;
}

export interface Transport {
  readonly kind: 'http-poll' | 'websocket';
  /** Begin registration + polling. Safe to call once. */
  start(): void;
  /** Queue an envelope for delivery (fire-and-forget, ordered best-effort). */
  send(env: Envelope): void;
  /** Set the desired username (only effective before start()). */
  setUsername(username: string): void;
  /** Stop polling and release resources. Final state: 'closed'. */
  close(): void;
  /** Subscribe to inbound envelopes. Returns an unsubscribe function. */
  onMessage(cb: (env: Envelope) => void): Unsubscribe;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  onStateChange(cb: (state: TransportState) => void): Unsubscribe;
  /** Counters for diagnostics. */
  stats(): TransportStats;
  /** Last transport error message, for logging. */
  readonly lastError: string | null;
  /** Username currently registered (null until welcome arrives). */
  username(): string | null;
}

export type Unsubscribe = () => void;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
