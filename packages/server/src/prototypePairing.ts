import { randomBytes } from 'node:crypto';
import type { DevicePublicKey } from './prototypeNoteCrypto.ts';
import { PrototypeNoteRelay, type DeviceDirectory } from './prototypeNoteRelay.ts';

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_BYTES = 10; // 80 bits before base32 formatting.
const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface PendingPairing {
  userId: string;
  expiresAt: number;
}

export interface PairingStart {
  userId: string;
  code: string;
  expiresAt: number;
  directory: DeviceDirectory;
}

export interface PairingClaim {
  userId: string;
  directory: DeviceDirectory;
}

export interface PrototypePairingOptions {
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  ttlMs?: number;
}

/**
 * Single-use code exchange for enrolling a WebView key into an AuthGravity
 * account. AuthGravity authentication is required only to create a code; code
 * possession authorizes exactly one new device registration before expiry.
 */
export class PrototypePairingService {
  private readonly userIdsBySubject = new Map<string, string>();
  private readonly pendingByCode = new Map<string, PendingPairing>();
  private readonly now: () => number;
  private readonly bytes: (length: number) => Uint8Array;
  private readonly ttlMs: number;

  constructor(private readonly relay: PrototypeNoteRelay, options: PrototypePairingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.bytes = options.randomBytes ?? randomBytes;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  start(subject: string, primaryDevice: DevicePublicKey): PairingStart {
    if (!isSubject(subject)) throw new Error('invalid authenticated subject');
    this.prune();
    const userId = this.userIdForSubject(subject);
    const directory = this.relay.registerDevice(userId, primaryDevice);
    let code: string;
    do { code = makeCode(this.bytes(CODE_BYTES)); } while (this.pendingByCode.has(code));
    const expiresAt = this.now() + this.ttlMs;
    this.pendingByCode.set(code, { userId, expiresAt });
    return { userId, code, expiresAt, directory };
  }

  claim(rawCode: string, device: DevicePublicKey): PairingClaim {
    this.prune();
    const code = normalizeCode(rawCode);
    if (!code) throw new Error('invalid or expired pairing code');
    const pairing = this.pendingByCode.get(code);
    if (!pairing || pairing.expiresAt <= this.now()) throw new Error('invalid or expired pairing code');
    // Consume before registration so a code can never be retried after a
    // network race. The pairing device can request a fresh code if validation
    // of its public key fails.
    this.pendingByCode.delete(code);
    return { userId: pairing.userId, directory: this.relay.registerDevice(pairing.userId, device) };
  }

  private userIdForSubject(subject: string): string {
    let userId = this.userIdsBySubject.get(subject);
    if (!userId) {
      // Never expose an AuthGravity subject in directory/routing metadata.
      userId = `account_${toBase32(this.bytes(12)).toLowerCase()}`;
      this.userIdsBySubject.set(subject, userId);
    }
    return userId;
  }

  private prune(): void {
    const now = this.now();
    for (const [code, pairing] of this.pendingByCode) {
      if (pairing.expiresAt <= now) this.pendingByCode.delete(code);
    }
  }
}

function isSubject(value: string): boolean {
  return value.length > 0 && value.length <= 512;
}

function makeCode(bytes: Uint8Array): string {
  const compact = toBase32(bytes).slice(0, 16);
  return `WRTN-${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}`;
}

function normalizeCode(value: string): string | null {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^WRTN[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/.test(compact)
    ? `WRTN-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}`
    : null;
}

function toBase32(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CODE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += CODE_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}
