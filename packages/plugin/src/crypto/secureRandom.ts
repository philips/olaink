/** Runtime gate for the Web Crypto CSPRNG required by future E2E encryption. */

interface RandomValuesCrypto {
  getRandomValues(values: Uint8Array): Uint8Array;
}

export interface SecureRandomProbe {
  available: boolean;
  detail: string;
}

function hasRandomValues(value: unknown): value is RandomValuesCrypto {
  return value !== null && typeof value === 'object' &&
    typeof (value as Partial<RandomValuesCrypto>).getRandomValues === 'function';
}

/**
 * Checks the actual JS runtime's Web Crypto interface without logging random
 * material. This establishes API availability, not a statistical proof of
 * entropy; Web Crypto's getRandomValues contract is the security guarantee.
 */
export function probeSecureRandom(source: unknown = globalThis.crypto): SecureRandomProbe {
  if (!hasRandomValues(source)) return { available: false, detail: 'crypto.getRandomValues is unavailable' };

  const sample = new Uint8Array(32).fill(0xa5);
  try {
    source.getRandomValues(sample);
  } catch (error) {
    return { available: false, detail: `crypto.getRandomValues threw: ${(error as Error).message}` };
  }
  if (sample.every((value) => value === 0xa5)) {
    return { available: false, detail: 'crypto.getRandomValues did not fill its output buffer' };
  }
  return { available: true, detail: 'Web Crypto getRandomValues is available' };
}

/** Log a deploy-visible result so the probe can be confirmed from logcat. */
export function logSecureRandomProbe(): SecureRandomProbe {
  const result = probeSecureRandom();
  console.log(`[wrtn] csprng probe: ${result.available ? 'PASS' : 'FAIL'} — ${result.detail}`);
  return result;
}
