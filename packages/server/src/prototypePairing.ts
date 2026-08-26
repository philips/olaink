import { createHash, randomBytes } from 'node:crypto';
import type { DevicePublicKey } from './prototypeNoteCrypto.ts';
import { PrototypeNoteRelay, type DeviceDirectory } from './prototypeNoteRelay.ts';
import type { PrototypeSqliteStore } from './prototypeSqliteStore.ts';

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_BYTES = 4;
const PAIRING_CODE_SPACE = 100_000_000;
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
  /** Limited bearer capability for this paired device's poll/ack endpoints. */
  deviceSessionToken: string;
}

export interface PrototypePairingOptions {
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  ttlMs?: number;
  /** Durable account mapping and single-use codes in the Bun deployment. */
  store?: PrototypeSqliteStore;
}

/**
 * Single-use code exchange for enrolling a WebView key into an AuthGravity
 * account. AuthGravity authentication is required only to create a code; code
 * possession authorizes exactly one new device registration before expiry.
 */
export class PrototypePairingService {
  private readonly userIdsBySubject = new Map<string, string>();
  private readonly pendingByCode = new Map<string, PendingPairing>();
  private readonly deviceSessions = new Map<string, string>();
  private readonly now: () => number;
  private readonly bytes: (length: number) => Uint8Array;
  private readonly ttlMs: number;

  constructor(private readonly relay: PrototypeNoteRelay, private readonly options: PrototypePairingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.bytes = options.randomBytes ?? randomBytes;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  start(subject: string, primaryDevice: DevicePublicKey): PairingStart {
    if (!isSubject(subject)) throw new Error('invalid authenticated subject');
    this.prune();
    const userId = this.accountForSubject(subject);
    const directory = this.relay.registerDevice(userId, primaryDevice);
    let code = '';
    do { code = makeCode(this.bytes(CODE_BYTES)); } while (!code || this.pairingExists(code));
    const expiresAt = this.now() + this.ttlMs;
    if (this.options.store) this.options.store.savePairing(code, userId, expiresAt);
    else this.pendingByCode.set(code, { userId, expiresAt });
    return { userId, code: formatCode(code), expiresAt, directory };
  }

  claim(rawCode: string, device: DevicePublicKey): PairingClaim {
    this.prune();
    const code = normalizeCode(rawCode);
    if (!code) throw new Error('invalid or expired pairing code');
    const userId = this.options.store
      ? this.options.store.takePairing(code, this.now())
      : this.takeMemoryPairing(code);
    if (!userId) throw new Error('invalid or expired pairing code');
    // Consume before registration so a code can never be retried after a
    // network race. The pairing device can request a fresh code if validation
    // of its public key fails.
    const directory = this.relay.registerDevice(userId, device);
    const deviceSessionToken = toBase64url(this.bytes(32));
    const tokenHash = hashSessionToken(deviceSessionToken);
    if (this.options.store) this.options.store.saveDeviceSession(tokenHash, device.deviceId, this.now());
    else {
      for (const [hash, id] of this.deviceSessions) if (id === device.deviceId) this.deviceSessions.delete(hash);
      this.deviceSessions.set(tokenHash, device.deviceId);
    }
    return { userId, directory, deviceSessionToken };
  }

  /** Resolves a pairing-created capability to its single enrolled device. */
  deviceForSession(token: string): string | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = hashSessionToken(token);
    return this.options.store ? this.options.store.deviceForSession(hash) : this.deviceSessions.get(hash) ?? null;
  }

  /** Resolve/create the opaque account mapping without enrolling a device. */
  accountForSubject(subject: string): string {
    if (!isSubject(subject)) throw new Error('invalid authenticated subject');
    if (this.options.store) {
      const existing = this.options.store.userIdForSubject(subject);
      if (existing) return existing;
      // Never expose an AuthGravity subject in directory/routing metadata.
      // A unique collision is astronomically unlikely, but never return an
      // unpersisted account ID if one does occur.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return this.options.store.saveSubjectUser(subject, `account_${toBase32(this.bytes(12)).toLowerCase()}`, this.now());
        } catch {
          const raced = this.options.store.userIdForSubject(subject);
          if (raced) return raced;
        }
      }
      throw new Error('could not allocate opaque account ID');
    }
    let userId = this.userIdsBySubject.get(subject);
    if (!userId) {
      userId = `account_${toBase32(this.bytes(12)).toLowerCase()}`;
      this.userIdsBySubject.set(subject, userId);
    }
    return userId;
  }

  private pairingExists(code: string): boolean {
    return this.options.store ? this.options.store.pairingExists(code) : this.pendingByCode.has(code);
  }

  private takeMemoryPairing(code: string): string | null {
    const pairing = this.pendingByCode.get(code);
    if (!pairing || pairing.expiresAt <= this.now()) return null;
    this.pendingByCode.delete(code);
    return pairing.userId;
  }

  private prune(): void {
    const now = this.now();
    if (this.options.store) {
      this.options.store.prunePairings(now);
      return;
    }
    for (const [code, pairing] of this.pendingByCode) {
      if (pairing.expiresAt <= now) this.pendingByCode.delete(code);
    }
  }
}

function isSubject(value: string): boolean {
  return value.length > 0 && value.length <= 512;
}

function makeCode(bytes: Uint8Array): string {
  if (bytes.length < CODE_BYTES) throw new Error('insufficient random bytes');
  const value = (bytes[0]! * 0x1000000) + (bytes[1]! * 0x10000) + (bytes[2]! * 0x100) + bytes[3]!;
  // Reject the tiny high range rather than introducing modulo bias.
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % PAIRING_CODE_SPACE);
  if (value >= limit) return '';
  return String(value % PAIRING_CODE_SPACE).padStart(8, '0');
}

function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeCode(value: string): string | null {
  const compact = value.replace(/\D/g, '');
  return /^\d{8}$/.test(compact) ? compact : null;
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
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
