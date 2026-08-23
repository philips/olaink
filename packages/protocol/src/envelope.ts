/**
 * WRTN message envelope.
 *
 * Every message on the wire (HTTP polling body, future WebSocket frames) is an
 * `Envelope`. The envelope is intentionally dumb — routing/meaning lives in
 * `type` + `payload`. Payload shapes per type are in `messages.ts`.
 */

export const PROTOCOL_VERSION = 1 as const;

export type EnvelopeType =
  | 'hello'
  | 'welcome'
  | 'join'
  | 'session.add'
  | 'session.leave'
  | 'session.state'
  | 'strokes'
  | 'page.send'
  | 'pages.ack'
  | 'ping'
  | 'pong'
  | 'error';

export interface Envelope<T = unknown> {
  /** Protocol version. Receivers must reject mismatches. */
  v: typeof PROTOCOL_VERSION;
  /** Sender username, or 'server' / 'echo' for server-side actors. */
  from: string;
  /** Unique message id (used for dedup/debugging; not acked in v1). */
  id: string;
  /** Sender wall-clock unix ms. Informational only. */
  ts: number;
  type: EnvelopeType;
  payload: T;
}

/**
 * Names that are never valid as client usernames.
 * - `server`/`echo`: protocol actors.
 * - `swaptest`: server-side test bot that generates pages on demand
 *   (POST /v1/test/swaptest/page).
 */
export const RESERVED_NAMES = ['server', 'echo', 'swaptest'] as const;

let idCounter = 0;

/**
 * Generate a message id without depending on crypto. Format: `<ts>-<rand>`.
 * Uniqueness within a process is guaranteed by the counter; across processes
 * the timestamp + random suffix is ample for this protocol's needs.
 */
export function newMessageId(): string {
  idCounter = (idCounter + 1) % 0x10000;
  const rand = Math.floor(Math.random() * 0x10000);
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${rand.toString(36)}`;
}

export function makeEnvelope<T>(
  from: string,
  type: EnvelopeType,
  payload: T,
): Envelope<T> {
  return { v: PROTOCOL_VERSION, from, id: newMessageId(), ts: Date.now(), type, payload };
}

/** Validate that an untrusted object is structurally an Envelope. */
export function isValidEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== 'object') return false;
  const env = value as Partial<Envelope>;
  return (
    env.v === PROTOCOL_VERSION &&
    typeof env.from === 'string' &&
    env.from.length > 0 &&
    env.from.length <= 64 &&
    typeof env.id === 'string' &&
    env.id.length > 0 &&
    env.id.length <= 64 &&
    typeof env.ts === 'number' &&
    Number.isFinite(env.ts) &&
    typeof env.type === 'string' &&
    env.type.length > 0
  );
}
