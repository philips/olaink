import { describe, expect, it } from 'vitest';
import { summarizeDistribution } from './statsMath.ts';

describe('summarizeDistribution', () => {
  it('returns all-zero stats for an empty distribution instead of NaN', () => {
    expect(summarizeDistribution([])).toEqual({ count: 0, minBytes: 0, medianBytes: 0, meanBytes: 0, maxBytes: 0 });
  });

  it('computes min/median/mean/max for an odd-length, unsorted distribution', () => {
    expect(summarizeDistribution([300, 100, 200])).toEqual({
      count: 3, minBytes: 100, medianBytes: 200, meanBytes: 200, maxBytes: 300,
    });
  });

  it('averages the two middle values for an even-length distribution', () => {
    expect(summarizeDistribution([100, 400, 200, 300])).toEqual({
      count: 4, minBytes: 100, medianBytes: 250, meanBytes: 250, maxBytes: 400,
    });
  });

  it('treats zeros (accounts with nothing queued) as real members of the distribution', () => {
    expect(summarizeDistribution([0, 0, 0, 900])).toMatchObject({ count: 4, minBytes: 0, medianBytes: 0, meanBytes: 225, maxBytes: 900 });
  });

  it('does not mutate its input', () => {
    const values = [5, 3, 1];
    summarizeDistribution(values);
    expect(values).toEqual([5, 3, 1]);
  });
});
