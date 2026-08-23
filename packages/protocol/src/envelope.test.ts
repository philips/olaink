import { describe, expect, it } from 'vitest';
import { RESERVED_NAMES, isValidEnvelope, makeEnvelope, newMessageId } from './envelope.ts';
import { decodeEnvelopes, encodeEnvelopes, isPageSendPayload, isPagesAckPayload, ProtocolError } from './messages.ts';

describe('envelope', () => {
  it('creates valid envelopes with unique ids', () => {
    const a = makeEnvelope('alice', 'ping', { t: 1 });
    const b = makeEnvelope('alice', 'ping', { t: 1 });
    expect(isValidEnvelope(a)).toBe(true);
    expect(a.id).not.toBe(b.id);
  });

  it('message ids are unique across rapid generation', () => {
    expect(new Set(Array.from({ length: 1000 }, () => newMessageId())).size).toBe(1000);
  });

  it('rejects malformed envelopes', () => {
    expect(isValidEnvelope(null)).toBe(false);
    expect(isValidEnvelope({})).toBe(false);
    expect(isValidEnvelope({ v: 2, from: 'a', id: 'x', ts: 1, type: 'ping' })).toBe(false);
  });
});

describe('codec', () => {
  it('round-trips a retained page envelope', () => {
    const envs = [makeEnvelope('alice', 'page.send', { to: 'bob', elements: [] })];
    expect(decodeEnvelopes(encodeEnvelopes(envs))).toEqual(envs);
  });

  it('throws ProtocolError on invalid input', () => {
    expect(() => decodeEnvelopes('not json')).toThrow(ProtocolError);
    expect(() => decodeEnvelopes('{"a":1}')).toThrow(ProtocolError);
  });
});

describe('reserved names', () => {
  it('reserves only server-side actors', () => {
    expect(RESERVED_NAMES).toEqual(['server', 'swaptest']);
  });
});

describe('page.send payload guard', () => {
  const stroke = { kind: 'stroke', stroke: { sid: 'e1', penColor: 0, penType: 10, thickness: 300, pts: [0.1, 0.2, 0.3, 0.4] } };
  const text = { kind: 'text', text: { sid: 't1', text: 'hi', fontSize: 24, rect: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.2 }, textAlign: 0, textFrameWidthType: 1 } };

  it('accepts valid page elements', () => {
    expect(isPageSendPayload({ to: 'bob', elements: [stroke, text] })).toBe(true);
  });

  it('rejects reserved recipients and malformed elements', () => {
    expect(isPageSendPayload({ to: 'server', elements: [stroke] })).toBe(false);
    expect(isPageSendPayload({ to: 'swaptest', elements: [stroke] })).toBe(false);
    expect(isPageSendPayload({ to: 'Bob Smith!', elements: [stroke] })).toBe(false);
    expect(isPageSendPayload({ to: 'bob', elements: [{ kind: 'stroke', stroke: { ...stroke.stroke, pts: [] } }] })).toBe(false);
  });
});

describe('pages.ack payload guard', () => {
  it('accepts bounded page ids and rejects empty ids', () => {
    expect(isPagesAckPayload({ pageIds: ['a', 'b'] })).toBe(true);
    expect(isPagesAckPayload({ pageIds: [] })).toBe(false);
  });
});
