import { describe, expect, it } from 'vitest';
import { AccountUsernameLedger, normalizeUsername } from './accountUsernames.ts';

describe('Ola Ink username contract', () => {
  it('canonicalizes ASCII uppercase and rejects invalid, Unicode, and reserved values', () => {
    expect(normalizeUsername('Mira-Notes')).toEqual({ ok: true, username: 'mira-notes' });
    for (const value of ['ab', 'a'.repeat(25), '-mira', 'mira-', 'mira--notes', 'mira notes', 'mîra', 'www']) {
      expect(normalizeUsername(value).ok).toBe(false);
    }
  });

  it('makes the exact first claim idempotent without permitting a rename or reuse', () => {
    const ledger = new AccountUsernameLedger(undefined);
    const first = ledger.claim('account_one', 'mira', 10);
    expect(first).toMatchObject({ outcome: 'assigned', idempotent: false });
    expect(ledger.claim('account_one', 'mira', 20)).toMatchObject({ outcome: 'assigned', idempotent: true });
    expect(ledger.claim('account_one', 'other', 20)).toMatchObject({ outcome: 'already_assigned' });
    expect(ledger.claim('account_two', 'mira', 20)).toEqual({ outcome: 'unavailable' });
  });
});
