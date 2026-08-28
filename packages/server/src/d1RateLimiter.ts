import type { D1DatabaseLike } from './d1Store.ts';

/**
 * Free-plan rate limiting for POST /v1/pairings/claim. The paid Workers Rate
 * Limiting binding is unavailable on the free plan, so the counter is a D1
 * table (pairing_claim_buckets). The upsert and the read-back run in one
 * db.batch() transaction, so concurrent claims cannot both observe
 * count <= limit, and the table works identically in the standalone binary's
 * SQLite shim.
 */
export class D1PairingClaimLimiter {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly limit = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts this attempt; returns true while it is within the limit. */
  async hit(clientKey: string): Promise<boolean> {
    const windowStart = Math.floor(this.now() / this.windowMs) * this.windowMs;
    const results = await this.db.batch([
      this.db.prepare(`
        INSERT INTO pairing_claim_buckets (client_key, window_start, count)
        VALUES (?, ?, 1)
        ON CONFLICT (client_key, window_start) DO UPDATE SET count = count + 1
      `).bind(clientKey, windowStart),
      this.db.prepare('SELECT count FROM pairing_claim_buckets WHERE client_key = ? AND window_start = ?')
        .bind(clientKey, windowStart),
      this.db.prepare('DELETE FROM pairing_claim_buckets WHERE window_start < ?').bind(windowStart),
    ]);
    const count = results[1]?.['results']?.[0]?.['count'] as number | undefined;
    return (count ?? 1) <= this.limit;
  }
}
