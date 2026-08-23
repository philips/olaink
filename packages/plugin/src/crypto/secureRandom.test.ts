import { describe, expect, it, vi } from 'vitest';
import { logSecureRandomProbe, probeSecureRandom } from './secureRandom.ts';

describe('secure-random runtime probe', () => {
  it('fails when Web Crypto is absent', () => {
    expect(probeSecureRandom(null)).toEqual({
      available: false,
      detail: 'crypto.getRandomValues is unavailable',
    });
  });

  it('fails when getRandomValues throws', () => {
    expect(probeSecureRandom({
      getRandomValues() { throw new Error('not supported'); },
    })).toEqual({
      available: false,
      detail: 'crypto.getRandomValues threw: not supported',
    });
  });

  it('fails when getRandomValues does not write its output buffer', () => {
    expect(probeSecureRandom({ getRandomValues: (values: Uint8Array) => values })).toEqual({
      available: false,
      detail: 'crypto.getRandomValues did not fill its output buffer',
    });
  });

  it('accepts a working Web Crypto-compatible provider', () => {
    expect(probeSecureRandom({
      getRandomValues(values: Uint8Array) { values.fill(0x12); return values; },
    })).toEqual({ available: true, detail: 'Web Crypto getRandomValues is available' });
  });

  it('logs a pass/fail result without exposing random bytes', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues(values: Uint8Array) { values.fill(0x12); return values; } },
    });
    try {
      logSecureRandomProbe();
      expect(spy).toHaveBeenCalledWith('[wrtn] csprng probe: PASS — Web Crypto getRandomValues is available');
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
      spy.mockRestore();
    }
  });
});
