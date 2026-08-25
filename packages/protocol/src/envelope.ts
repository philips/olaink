/** Ola Ink message envelope. */

export const PROTOCOL_VERSION = 1 as const;

export type EnvelopeType =
  | 'hello'
  | 'welcome'
  | 'page.send'
  | 'pages.ack'
  | 'ping'
  | 'pong'
  | 'error';

export interface Envelope<T = unknown> {
  v: typeof PROTOCOL_VERSION;
  /** Sender username, or a server-side actor such as `server`/`swaptest`. */
  from: string;
  /** Unique message id; page.send ids are also page identities. */
  id: string;
  ts: number;
  type: EnvelopeType;
  payload: T;
}

/** Names that clients cannot claim. */
export const RESERVED_NAMES = ['server', 'swaptest'] as const;

let idCounter = 0;

export function newMessageId(): string {
  idCounter = (idCounter + 1) % 0x10000;
  const rand = Math.floor(Math.random() * 0x10000);
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${rand.toString(36)}`;
}

export function makeEnvelope<T>(from: string, type: EnvelopeType, payload: T): Envelope<T> {
  return { v: PROTOCOL_VERSION, from, id: newMessageId(), ts: Date.now(), type, payload };
}

export function isValidEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== 'object') return false;
  const env = value as Partial<Envelope>;
  return (
    env.v === PROTOCOL_VERSION &&
    typeof env.from === 'string' && env.from.length > 0 && env.from.length <= 64 &&
    typeof env.id === 'string' && env.id.length > 0 && env.id.length <= 64 &&
    typeof env.ts === 'number' && Number.isFinite(env.ts) &&
    typeof env.type === 'string' && env.type.length > 0
  );
}
