import { describe, expect, it } from 'vitest';
import { buildCommit } from './buildInfo.ts';

describe('build info', () => {
  it('reports a full commit SHA, or unknown outside a checkout', () => {
    expect(buildCommit).toMatch(/^(?:[0-9a-f]{40}|unknown)$/);
  });
});
