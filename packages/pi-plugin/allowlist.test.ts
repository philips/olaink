import { describe, expect, it } from 'vitest';
import { allowedSenderIds, describeAllowlist, partitionRecordsByAllowlist } from './allowlist.ts';

describe('allowedSenderIds', () => {
  it('is undefined (no restriction) when no allowlist is configured', () => {
    expect(allowedSenderIds(undefined)).toBeUndefined();
  });

  it('is an empty set (reject everyone) for an explicitly empty allowlist', () => {
    expect(allowedSenderIds([])).toEqual(new Set());
  });

  it('collects configured sender userIds', () => {
    const set = allowedSenderIds([{ username: 'alice', userId: 'user_1' }, { username: 'bob', userId: 'user_2' }]);
    expect(set).toEqual(new Set(['user_1', 'user_2']));
  });
});

describe('partitionRecordsByAllowlist', () => {
  const records = [
    { id: 'a', fromUserId: 'user_1' },
    { id: 'b', fromUserId: 'user_2' },
    { id: 'c', fromUserId: 'user_3' },
  ];

  it('accepts everything when there is no restriction configured', () => {
    expect(partitionRecordsByAllowlist(records, undefined)).toEqual({ allowed: records, rejected: [] });
  });

  it('keeps only records whose fromUserId is on the allowlist', () => {
    const result = partitionRecordsByAllowlist(records, new Set(['user_1', 'user_3']));
    expect(result.allowed).toEqual([records[0], records[2]]);
    expect(result.rejected).toEqual([records[1]]);
  });

  it('rejects everything for an explicitly empty allowlist (fail closed)', () => {
    const result = partitionRecordsByAllowlist(records, new Set());
    expect(result.allowed).toEqual([]);
    expect(result.rejected).toEqual(records);
  });

  it('treats a record without a string fromUserId as untrusted', () => {
    const malformed = [{ id: 'x', fromUserId: 42 }, { id: 'y' }];
    const result = partitionRecordsByAllowlist(malformed, new Set(['user_1']));
    expect(result.allowed).toEqual([]);
    expect(result.rejected).toEqual(malformed);
  });
});

describe('describeAllowlist', () => {
  it('describes the open default', () => {
    expect(describeAllowlist(undefined)).toMatch(/any sender/);
  });

  it('describes a fail-closed empty allowlist', () => {
    expect(describeAllowlist([])).toMatch(/Blocking every sender/);
  });

  it('lists configured usernames', () => {
    expect(describeAllowlist([{ username: 'alice', userId: 'user_1' }])).toBe('Accepting notes only from: @alice');
  });
});
