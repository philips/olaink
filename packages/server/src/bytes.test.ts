import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64, toBase64Url } from './bytes.ts';

describe('runtime-agnostic base64 helpers', () => {
  it('encodes canonically (matches platform base64url) for all lengths', () => {
    for (let len = 0; len < 200; len += 1) {
      const data = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) data[i] = (i * 73 + len * 31 + 7) & 0xff;
      expect(toBase64Url(data)).toBe(Buffer.from(data).toString('base64url'));
    }
  });

  it('round-trips, including the empty input', () => {
    const data = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0xfd]);
    expect(toBase64Url(data)).toBe(Buffer.from(data).toString('base64url'));
    expect(fromBase64Url(toBase64Url(data))).toEqual(data);
    expect(toBase64Url(new Uint8Array(0))).toBe('');
    expect(fromBase64Url('')).toEqual(new Uint8Array(0));
  });

  it('rejects non-canonical trailing bits and non-alphabet characters', () => {
    // 0x0f = 0000 1111 -> 000011 11(0000) -> "Dw"; "Dx" sets padding bits.
    expect(toBase64Url(new Uint8Array([0x0f]))).toBe('Dw');
    expect(fromBase64Url('Dw')).toEqual(new Uint8Array([0x0f]));
    expect(fromBase64Url('Dx')).toBeNull();
    expect(fromBase64Url('D=')).toBeNull();
    expect(fromBase64Url('Dwabc')).toBeNull(); // length % 4 === 1
    expect(fromBase64Url('Dwabcde')).toBeNull(); // non-canonical padding bits
  });

  it('encodes standard padded base64 for CSP nonces', () => {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) bytes[i] = i;
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(toBase64(new Uint8Array([0xff]))).toBe('/w==');
    expect(toBase64(new Uint8Array([0xff, 0xff]))).toBe('//8=');
  });
});
