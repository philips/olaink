/**
 * Payload types per message type, plus structural type guards.
 *
 * Wire strokes are the Supernote-essentials subset: enough to recreate a
 * stroke on another device (element type 0) via createElement + insertElements.
 * Points are flat `[x0, y0, x1, y1, ...]` in the sender's EMR digitizer
 * coordinates (integers), which both Nomad-class devices share
 * (15819 x 11864 max, portrait). Devices with different geometry convert
 * on receipt.
 */

import type { Envelope, EnvelopeType } from './envelope.ts';
import { isValidEnvelope } from './envelope.ts';

export interface HelloPayload {
  /** Requested username. Server may reject if taken (error username_taken). */
  username: string;
  /** Supernote machine type from PluginManager.getDeviceType(). */
  deviceType: number;
  /** Human-readable client version string. */
  client: string;
}

export interface WelcomePayload {
  username: string;
  /** Session token for subsequent calls. Empty when auth disabled. */
  token: string;
  serverTime: number;
  /** Highest server time the client can use to sanity-check its clock. */
  features: string[];
}

export interface JoinPayload {
  /** Username of the session owner (session == owner's active session). */
  owner: string;
}

export interface SessionAddPayload {
  /** Username to add to my session (I must be the owner or a member). */
  target: string;
}

export interface SessionLeavePayload {}

export interface SessionStateMember {
  username: string;
  /** True for server-side actors like echo. */
  virtual: boolean;
}

export interface SessionStatePayload {
  owner: string;
  members: SessionStateMember[];
}

export interface StrokePayload {
  /** Sender-side element uuid. Used for dedup, not for identity on receipt. */
  sid: string;
  /** Page index within the note (0-based). */
  page: number;
  /** Layer number. */
  layer: number;
  /** Pen color: 0x00 black, 0x9D dark gray, 0xC9 light gray, 0xFE white. */
  penColor: number;
  /** Pen type: 10 fineliner, 1 pressure, 11 marker, 14 calligraphy. */
  penType: number;
  /** Stroke thickness (>= 100). */
  thickness: number;
  /** Flat point array [x0,y0,x1,y1,...], EMR ints. */
  pts: number[];
  /** Optional pressures, same length as pts / 2, 0..1 scaled to 0..4095. */
  prs?: number[];
}

export interface StrokesPayload {
  sessionIdNote?: string;
  strokes: StrokePayload[];
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface PingPayload {
  /** Client's idea of now (ms). */
  t: number;
}

export interface PongPayload {
  /** Echo of the ping's t plus the server's now at reply time. */
  t: number;
  serverNow: number;
}

export interface PayloadMap {
  hello: HelloPayload;
  welcome: WelcomePayload;
  join: JoinPayload;
  'session.add': SessionAddPayload;
  'session.leave': SessionLeavePayload;
  'session.state': SessionStatePayload;
  strokes: StrokesPayload;
  ping: PingPayload;
  pong: PongPayload;
  error: ErrorPayload;
}

export type TypedEnvelope<K extends EnvelopeType = EnvelopeType> = Envelope<
  K extends keyof PayloadMap ? PayloadMap[K] : unknown
>;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isInt(v: unknown): v is number {
  return isNumber(v) && Number.isInteger(v);
}

export function isHelloPayload(p: unknown): p is HelloPayload {
  return (
    isObject(p) && isString(p.username) && isNumber(p.deviceType) && isString(p.client)
  );
}

export function isWelcomePayload(p: unknown): p is WelcomePayload {
  return (
    isObject(p) &&
    isString(p.username) &&
    isString(p.token) &&
    isNumber(p.serverTime) &&
    Array.isArray(p.features)
  );
}

export function isJoinPayload(p: unknown): p is JoinPayload {
  return isObject(p) && isString(p.owner);
}

export function isSessionAddPayload(p: unknown): p is SessionAddPayload {
  return isObject(p) && isString(p.target);
}

export function isSessionLeavePayload(p: unknown): p is SessionLeavePayload {
  return isObject(p);
}

export function isSessionStatePayload(p: unknown): p is SessionStatePayload {
  if (!(isObject(p) && isString(p.owner) && Array.isArray(p.members))) return false;
  return p.members.every(
    (m) =>
      isObject(m) &&
      isString(m.username) &&
      typeof m.virtual === 'boolean',
  );
}

export function isStrokePayload(p: unknown): p is StrokePayload {
  if (
    !(
      isObject(p) &&
      isString(p.sid) &&
      isInt(p.page) &&
      isInt(p.layer) &&
      isInt(p.penColor) &&
      isInt(p.penType) &&
      isInt(p.thickness) &&
      Array.isArray(p.pts)
    )
  ) {
    return false;
  }
  if (p.pts.length < 4 || p.pts.length % 2 !== 0) return false;
  if (!p.pts.every((n) => isInt(n))) return false;
  if (p.prs !== undefined) {
    if (!Array.isArray(p.prs) || p.prs.length !== p.pts.length / 2) return false;
    if (!p.prs.every((n) => isInt(n))) return false;
  }
  return true;
}

export function isStrokesPayload(p: unknown): p is StrokesPayload {
  return isObject(p) && Array.isArray(p.strokes) && p.strokes.every(isStrokePayload);
}

export function isErrorPayload(p: unknown): p is ErrorPayload {
  return isObject(p) && isString(p.code) && isString(p.message);
}

export function isPingPayload(p: unknown): p is PingPayload {
  return isObject(p) && isNumber(p.t);
}

export function isPongPayload(p: unknown): p is PongPayload {
  return isObject(p) && isNumber(p.t) && isNumber(p.serverNow);
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Encode envelopes to a wire string. */
export function encodeEnvelopes(envs: Envelope[]): string {
  return JSON.stringify(envs);
}

/** Decode + validate a wire string into envelopes. Throws ProtocolError. */
export function decodeEnvelopes(text: string): Envelope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProtocolError(`invalid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new ProtocolError('expected array of envelopes');
  for (const env of parsed) {
    if (!isValidEnvelope(env)) throw new ProtocolError(`invalid envelope: ${JSON.stringify(env)}`);
  }
  return parsed as Envelope[];
}
