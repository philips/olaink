/**
 * Short, readable, speakable username generation.
 *
 * Format: `<adjective>-<noun>-<nn>` e.g. `quiet-otter-42`.
 * ~10 chars, typable on a phone, sayable out loud. The server is the
 * authority on uniqueness — `hello` retries with a fresh candidate on
 * `username_taken`.
 *
 * Randomness: Math.random (Hermes has no crypto.getRandomValues without a
 * native polyfill). This is not a security boundary — the Tailscale network
 * is — just a collision-avoidance mechanism.
 */

import { RESERVED_NAMES } from './envelope.ts';

const ADJECTIVES = [
  'amber', 'bold', 'calm', 'dusk', 'eager', 'fern', 'gentle', 'hazel',
  'icy', 'jade', 'keen', 'lilac', 'mellow', 'nimble', 'opal', 'plum',
  'quiet', 'rustic', 'slate', 'tidal', 'umber', 'velvet', 'wisp', 'zesty',
  'brave', 'crisp', 'dapper', 'eloquent', 'flint', 'glossy',
] as const;

const NOUNS = [
  'otter', 'falcon', 'cedar', 'harbor', 'juniper', 'kettle', 'linden',
  'maple', 'nectar', 'orbit', 'pebble', 'quartz', 'raven', 'sable',
  'thistle', 'urchin', 'violet', 'walnut', 'yarrow', 'zephyr', 'acorn',
  'badger', 'clover', 'dunlin', 'ember', 'finch', 'gorse', 'heron',
  'iris', 'lotus',
] as const;

export const USERNAME_MAX_LENGTH = 24;
const USERNAME_PATTERN = /^[a-z0-9-]+$/;

export interface RandomSource {
  (): number;
}

const defaultRandom: RandomSource = Math.random;

function pick<T>(list: readonly T[], rand: RandomSource): T {
  return list[Math.floor(rand() * list.length)] as T;
}

/** Generate a candidate username like `quiet-otter-42`. */
export function generateUsername(rand: RandomSource = defaultRandom): string {
  const adj = pick(ADJECTIVES, rand);
  const noun = pick(NOUNS, rand);
  const n = Math.floor(rand() * 100);
  return `${adj}-${noun}-${n}`;
}

/** Structural validity check (lowercase letters, digits, dashes; not reserved). */
export function isValidUsername(name: string): boolean {
  if (name.length === 0 || name.length > USERNAME_MAX_LENGTH) return false;
  if (!USERNAME_PATTERN.test(name)) return false;
  if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) return false;
  if ((RESERVED_NAMES as readonly string[]).includes(name)) return false;
  return true;
}

/**
 * Generate usernames until one is structurally valid (and optionally not in
 * `taken`). Bounded attempts to keep the loop honest.
 */
export function generateUniqueUsername(
  taken: Iterable<string>,
  rand: RandomSource = defaultRandom,
  attempts = 8,
): string {
  const takenSet = new Set(taken);
  for (let i = 0; i < attempts; i++) {
    const candidate = generateUsername(rand);
    if (isValidUsername(candidate) && !takenSet.has(candidate)) return candidate;
  }
  // Astronomically unlikely; fall back to a longer suffix.
  const fallback = `${generateUsername(rand)}-${Math.floor(rand() * 1000)}`;
  return fallback;
}
