import { describe, expect, it } from 'vitest';
import {
  RESERVED_NAMES,
  isValidEnvelope,
  makeEnvelope,
  newMessageId,
} from './envelope.ts';
import {
  decodeEnvelopes,
  encodeEnvelopes,
  isStrokesPayload,
  ProtocolError,
} from './messages.ts';

describe('envelope', () => {
  it('creates valid envelopes with unique ids', () => {
    const a = makeEnvelope('alice', 'ping', { t: 1 });
    const b = makeEnvelope('alice', 'ping', { t: 1 });
    expect(isValidEnvelope(a)).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(a.v).toBe(1);
    expect(a.from).toBe('alice');
  });

  it('message ids are unique across rapid generation', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newMessageId()));
    expect(ids.size).toBe(1000);
  });

  it('rejects malformed envelopes', () => {
    expect(isValidEnvelope(null)).toBe(false);
    expect(isValidEnvelope({})).toBe(false);
    expect(isValidEnvelope({ v: 2, from: 'a', id: 'x', ts: 1, type: 'ping' })).toBe(false);
    expect(isValidEnvelope({ v: 1, from: '', id: 'x', ts: 1, type: 'ping' })).toBe(false);
    expect(
      isValidEnvelope({ v: 1, from: 'a', id: 'x', ts: Number.NaN, type: 'ping' }),
    ).toBe(false);
  });
});

describe('codec', () => {
  it('round-trips envelopes', () => {
    const envs = [
      makeEnvelope('alice', 'strokes', {
        strokes: [
          {
            sid: 'e1',
            page: 0,
            layer: 0,
            penColor: 0,
            penType: 10,
            thickness: 300,
            pts: [1, 2, 3, 4],
            prs: [100, 200],
          },
        ],
      }),
    ];
    const text = encodeEnvelopes(envs);
    const back = decodeEnvelopes(text);
    expect(back).toEqual(envs);
  });

  it('throws ProtocolError on bad input', () => {
    expect(() => decodeEnvelopes('not json')).toThrow(ProtocolError);
    expect(() => decodeEnvelopes('{"a":1}')).toThrow(ProtocolError);
    expect(() => decodeEnvelopes('[{"nope":true}]')).toThrow(ProtocolError);
  });
});

describe('strokes payload guard', () => {
  const base = {
    sid: 's1',
    page: 0,
    layer: 0,
    penColor: 0,
    penType: 10,
    thickness: 300,
  };

  it('accepts valid payloads', () => {
    expect(isStrokesPayload({ strokes: [{ ...base, pts: [0, 0, 5, 5] }] })).toBe(true);
    expect(
      isStrokesPayload({
        strokes: [{ ...base, pts: [0, 0, 5, 5], prs: [1, 2] }],
      }),
    ).toBe(true);
  });

  it('rejects bad point arrays', () => {
    expect(isStrokesPayload({ strokes: [{ ...base, pts: [] }] })).toBe(false);
    expect(isStrokesPayload({ strokes: [{ ...base, pts: [1, 2, 3] }] })).toBe(false);
    expect(isStrokesPayload({ strokes: [{ ...base, pts: [1.5, 2] }] })).toBe(false);
    expect(
      isStrokesPayload({ strokes: [{ ...base, pts: [1, 2, 3, 4], prs: [1] }] }),
    ).toBe(false);
  });

  it('rejects non-arrays', () => {
    expect(isStrokesPayload({})).toBe(false);
    expect(isStrokesPayload({ strokes: 'nope' })).toBe(false);
  });
});

describe('reserved names', () => {
  it('includes server and echo', () => {
    expect(RESERVED_NAMES).toContain('server');
    expect(RESERVED_NAMES).toContain('echo');
  });
});
