/** Pure numeric helpers for summarizing the per-account storage distribution shown on GET /stats. */

export interface Distribution {
  count: number;
  minBytes: number;
  medianBytes: number;
  meanBytes: number;
  maxBytes: number;
}

const EMPTY: Distribution = { count: 0, minBytes: 0, medianBytes: 0, meanBytes: 0, maxBytes: 0 };

/** `values` need not be sorted; an empty array yields all-zero stats rather than NaN. */
export function summarizeDistribution(values: readonly number[]): Distribution {
  if (values.length === 0) return EMPTY;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianBytes = sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    minBytes: sorted[0] ?? 0,
    medianBytes,
    meanBytes: sum / sorted.length,
    maxBytes: sorted[sorted.length - 1] ?? 0,
  };
}
