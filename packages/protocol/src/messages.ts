/** Payload types and structural guards for the SwapNote protocol. */

import type { Envelope, EnvelopeType } from './envelope.ts';
import { isValidEnvelope } from './envelope.ts';
import { isValidUsername } from './username.ts';

export interface HelloPayload {
  username: string;
  deviceType: number;
  client: string;
}

export interface WelcomePayload {
  username: string;
  token: string;
  serverTime: number;
  features: string[];
}

/** A stroke inside a transferred page, in normalized EMR coordinates. */
export interface PageStroke {
  sid: string;
  penColor: number;
  penType: number;
  thickness: number;
  pts: number[];
  prs?: number[];
}

export interface PageText {
  sid: string;
  text: string;
  fontSize: number;
  rect: { left: number; top: number; right: number; bottom: number };
  textAlign: number;
  textFrameWidthType: number;
}

export type PageElement =
  | { kind: 'stroke'; stroke: PageStroke }
  | { kind: 'text'; text: PageText };

export interface PageSendPayload {
  to: string;
  elements: PageElement[];
}

export interface PagesAckPayload {
  pageIds: string[];
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface PingPayload { t: number; }
export interface PongPayload { t: number; serverNow: number; }

export interface PayloadMap {
  hello: HelloPayload;
  welcome: WelcomePayload;
  'page.send': PageSendPayload;
  'pages.ack': PagesAckPayload;
  ping: PingPayload;
  pong: PongPayload;
  error: ErrorPayload;
}

export type TypedEnvelope<K extends EnvelopeType = EnvelopeType> = Envelope<
  K extends keyof PayloadMap ? PayloadMap[K] : unknown
>;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}
function isString(v: unknown): v is string { return typeof v === 'string'; }
function isNumber(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function isInt(v: unknown): v is number { return isNumber(v) && Number.isInteger(v); }

export function isHelloPayload(p: unknown): p is HelloPayload {
  return isObject(p) && isString(p.username) && isNumber(p.deviceType) && isString(p.client);
}

export function isWelcomePayload(p: unknown): p is WelcomePayload {
  return isObject(p) && isString(p.username) && isString(p.token) && isNumber(p.serverTime) && Array.isArray(p.features);
}

export function isPageStroke(p: unknown): p is PageStroke {
  if (!(isObject(p) && isString(p.sid) && isInt(p.penColor) && isInt(p.penType) && isInt(p.thickness) && Array.isArray(p.pts))) return false;
  if (p.pts.length < 2 || p.pts.length % 2 !== 0) return false;
  if (!p.pts.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= -0.001 && n <= 1.001)) return false;
  if (p.prs !== undefined) {
    if (!Array.isArray(p.prs) || p.prs.length !== p.pts.length / 2) return false;
    if (!p.prs.every(isInt)) return false;
  }
  return true;
}

function isNormalizedRect(p: unknown): p is { left: number; top: number; right: number; bottom: number } {
  return isObject(p) && ['left', 'top', 'right', 'bottom'].every(
    (k) => typeof p[k] === 'number' && Number.isFinite(p[k]) && (p[k] as number) >= -0.001 && (p[k] as number) <= 1.001,
  );
}

export function isPageText(p: unknown): p is PageText {
  return isObject(p) && isString(p.sid) && isString(p.text) && isInt(p.fontSize) &&
    isNormalizedRect(p.rect) && isInt(p.textAlign) && isInt(p.textFrameWidthType);
}

export function isPageElement(p: unknown): p is PageElement {
  if (!isObject(p)) return false;
  if (p.kind === 'stroke') return isPageStroke(p.stroke);
  if (p.kind === 'text') return isPageText(p.text);
  return false;
}

export function isPageSendPayload(p: unknown): p is PageSendPayload {
  return isObject(p) && typeof p.to === 'string' && Array.isArray(p.elements) &&
    isValidUsername(p.to) && p.elements.every(isPageElement);
}

export function isPagesAckPayload(p: unknown): p is PagesAckPayload {
  return isObject(p) && Array.isArray(p.pageIds) && p.pageIds.length > 0 && p.pageIds.length <= 500 &&
    p.pageIds.every((id) => isString(id) && id.length <= 64);
}

export function isErrorPayload(p: unknown): p is ErrorPayload {
  return isObject(p) && isString(p.code) && isString(p.message);
}
export function isPingPayload(p: unknown): p is PingPayload { return isObject(p) && isNumber(p.t); }
export function isPongPayload(p: unknown): p is PongPayload { return isObject(p) && isNumber(p.t) && isNumber(p.serverNow); }

export class ProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'ProtocolError'; }
}

export function encodeEnvelopes(envs: Envelope[]): string { return JSON.stringify(envs); }

export function decodeEnvelopes(text: string): Envelope[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) { throw new ProtocolError(`invalid JSON: ${(err as Error).message}`); }
  if (!Array.isArray(parsed)) throw new ProtocolError('expected array of envelopes');
  for (const env of parsed) if (!isValidEnvelope(env)) throw new ProtocolError(`invalid envelope: ${JSON.stringify(env)}`);
  return parsed as Envelope[];
}
