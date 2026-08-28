/**
 * Pure runtime-agnostic byte/base64 helpers shared by the Worker, the
 * standalone binary, and the test suites (no Buffer, no node:crypto).
 */

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bytes backed by a plain ArrayBuffer (WebCrypto `BufferSource`-compatible). */
export type ByteArray = Uint8Array<ArrayBuffer>;

/** Encodes as unpadded base64url (canonical: trailing bits are zero). */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i + 3 <= len; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64URL_ALPHABET[(n >> 18) & 63];
    out += B64URL_ALPHABET[(n >> 12) & 63];
    out += B64URL_ALPHABET[(n >> 6) & 63];
    out += B64URL_ALPHABET[n & 63];
  }
  const rem = len % 3;
  if (rem === 1) {
    const n = (bytes[len - 1] ?? 0) << 4;
    out += B64URL_ALPHABET[(n >> 6) & 63];
    out += B64URL_ALPHABET[n & 63];
  } else if (rem === 2) {
    const n = ((bytes[len - 2] ?? 0) << 10) | ((bytes[len - 1] ?? 0) << 2);
    out += B64URL_ALPHABET[(n >> 12) & 63];
    out += B64URL_ALPHABET[(n >> 6) & 63];
    out += B64URL_ALPHABET[n & 63];
  }
  return out;
}

/**
 * Decodes canonical unpadded base64url. Returns null for non-alphabet
 * characters, impossible lengths, or non-canonical trailing bits (matching
 * the round-trip strictness the relay's validators require).
 */
export function fromBase64Url(value: string): ByteArray | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  if (value.length % 4 === 1) return null;
  let bits = 0;
  let bitCount = 0;
  const buffer = new Uint8Array(Math.ceil((value.length * 6) / 8) + 1);
  let index = 0;
  for (const char of value) {
    bits = (bits << 6) | B64URL_ALPHABET.indexOf(char);
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      buffer[index++] = (bits >> bitCount) & 0xff;
    }
  }
  if (bitCount > 0 && (bits & ((1 << bitCount) - 1)) !== 0) return null;
  return buffer.subarray(0, index);
}

/** Encodes as standard padded base64 (used for the per-request CSP nonce). */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? (bytes[i + 1] ?? 0) : 0;
    const b2 = has2 ? (bytes[i + 2] ?? 0) : 0;
    out += B64_ALPHABET[(b0 >> 2) & 63];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += has1 ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += has2 ? B64_ALPHABET[b2 & 63] : '=';
  }
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Encode(value: string): ByteArray {
  return textEncoder.encode(value);
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}
