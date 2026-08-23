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
  isPageSendPayload,
  isPagesAckPayload,
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
            pts: [0.1, 0.2, 0.3, 0.4],
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
    expect(isStrokesPayload({ strokes: [{ ...base, pts: [0, 0, 0.5, 0.5] }] })).toBe(true);
    expect(
      isStrokesPayload({
        strokes: [{ ...base, pts: [0, 0, 0.5, 0.5], prs: [1, 2] }],
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

  it('includes the swaptest bot', () => {
    expect(RESERVED_NAMES).toContain('swaptest');
  });
});

describe('page.send payload guard', () => {
  const stroke = {
    kind: 'stroke',
    stroke: {
      sid: 'e1',
      penColor: 0,
      penType: 10,
      thickness: 300,
      pts: [0.1, 0.2, 0.3, 0.4],
    },
  };
  const text = {
    kind: 'text',
    text: {
      sid: 't1',
      text: 'hi',
      fontSize: 24,
      rect: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.2 },
      textAlign: 0,
      textFrameWidthType: 1,
    },
  };

  it('accepts valid payloads', () => {
    expect(isPageSendPayload({ to: 'bob', elements: [stroke] })).toBe(true);
    expect(isPageSendPayload({ to: 'bob', elements: [stroke, text] })).toBe(true);
  });

  it('rejects reserved/bad recipients', () => {
    expect(isPageSendPayload({ to: 'server', elements: [stroke] })).toBe(false);
    expect(isPageSendPayload({ to: 'echo', elements: [stroke] })).toBe(false);
    expect(isPageSendPayload({ to: 'swaptest', elements: [stroke] })).toBe(false);
    expect(isPageSendPayload({ to: 'Bob Smith!', elements: [stroke] })).toBe(false);
  });

  it('rejects malformed elements', () => {
    expect(isPageSendPayload({ to: 'bob', elements: [] })).toBe(true);
    expect(isPageSendPayload({ to: 'bob', elements: [{ kind: 'stroke', stroke: { ...stroke.stroke, pts: [] } }] })).toBe(false);
    expect(isPageSendPayload({ to: 'bob', elements: [{ kind: 'stroke', stroke: { ...stroke.stroke, pts: [0, 0, 2] } }] })).toBe(false);
    expect(isPageSendPayload({ to: 'bob', elements: [{ kind: 'blob' }] })).toBe(false);
    expect(isPageSendPayload({ to: 'bob', elements: [{ kind: 'text', text: { ...text.text, rect: { left: -1, top: 0, right: 0.4, bottom: 0.2 } } }] })).toBe(false);
    expect(isPageSendPayload({ to: 'bob' })).toBe(false);
  });
});

describe('pages.ack payload guard', () => {
  it('accepts a list of page ids', () => {
    expect(isPagesAckPayload({ pageIds: ['a', 'b'] })).toBe(true);
  });

  it('rejects empty, non-string, or huge lists', () => {
    expect(isPagesAckPayload({ pageIds: [] })).toBe(false);
    expect(isPagesAckPayload({ pageIds: [1] })).toBe(false);
    expect(isPagesAckPayload({ pageIds: Array.from({ length: 501 }, (_, i) => `p${i}`) })).toBe(false);
    expect(isPagesAckPayload({})).toBe(false);
  });
});
