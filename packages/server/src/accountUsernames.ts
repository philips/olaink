import type { PrototypeSqliteStore, UsernameAssignment } from './prototypeSqliteStore.ts';

export const RESERVED_USERNAMES = new Set([
  'admin', 'api', 'app', 'authgravity', 'echo', 'help', 'olaink', 'root', 'support', 'www',
]);

export type UsernameValidation =
  | { ok: true; username: string }
  | { ok: false; error: 'invalid_username' | 'reserved_username' };

export type UsernameClaimResult =
  | { outcome: 'assigned'; assignment: UsernameAssignment; idempotent: boolean }
  | { outcome: 'unavailable' }
  | { outcome: 'already_assigned'; assignment: UsernameAssignment };

/**
 * The product username parser. It intentionally accepts only ASCII uppercase
 * as a spelling variant, then returns the canonical lowercase value.
 */
export function normalizeUsername(value: unknown): UsernameValidation {
  if (typeof value !== 'string' || value.length < 3 || value.length > 24) {
    return { ok: false, error: 'invalid_username' };
  }
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value)) {
    return { ok: false, error: 'invalid_username' };
  }
  const username = value.toLowerCase();
  return RESERVED_USERNAMES.has(username)
    ? { ok: false, error: 'reserved_username' }
    : { ok: true, username };
}

/** SQLite-backed one-account/one-name rules shared by tests and deployment. */
export class AccountUsernameLedger {
  constructor(private readonly store: PrototypeSqliteStore) {}

  usernameForUser(userId: string): UsernameAssignment | null {
    return this.store.usernameForUser(userId);
  }

  claim(userId: string, username: string, now: number): UsernameClaimResult {
    return this.store.claimUsername(userId, username, now);
  }

  resolveActiveUsername(username: string): UsernameAssignment | null {
    return this.store.resolveActiveUsername(username);
  }
}
