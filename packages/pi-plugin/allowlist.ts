/**
 * Pure sender-allowlist logic for the Ola Ink Pi extension.
 *
 * The relay authenticates `record.fromUserId`: it only accepts a send whose
 * `fromUserId` matches the account that owns the authenticated sending
 * device (see `acceptNote` in the server). That makes `fromUserId` a safe,
 * pre-decryption signal for "who really sent this," independent of anything
 * inside the ciphertext.
 */

export type AllowedSender = { username: string; userId: string };

/**
 * `undefined` allowedSenders means no restriction is configured (accept
 * anyone who knows your username - the historical default). A configured
 * list, even an empty one, means "accept only these senders" - fail closed
 * rather than silently reopening the inbox when the last entry is removed.
 */
export function allowedSenderIds(allowedSenders: AllowedSender[] | undefined): Set<string> | undefined {
  return allowedSenders === undefined ? undefined : new Set(allowedSenders.map((sender) => sender.userId));
}

export function partitionRecordsByAllowlist<T extends { fromUserId?: unknown }>(
  records: readonly T[], allowedUserIds: Set<string> | undefined,
): { allowed: T[]; rejected: T[] } {
  if (allowedUserIds === undefined) return { allowed: [...records], rejected: [] };
  const allowed: T[] = [];
  const rejected: T[] = [];
  for (const record of records) {
    if (typeof record.fromUserId === 'string' && allowedUserIds.has(record.fromUserId)) allowed.push(record);
    else rejected.push(record);
  }
  return { allowed, rejected };
}

export function describeAllowlist(allowedSenders: AllowedSender[] | undefined): string {
  if (allowedSenders === undefined) return 'Accepting notes from any sender who knows your Ola Ink username.';
  if (allowedSenders.length === 0) return 'Blocking every sender: the allowlist is empty. Use /olaink allow add USERNAME.';
  return `Accepting notes only from: ${allowedSenders.map((sender) => `@${sender.username}`).join(', ')}`;
}
