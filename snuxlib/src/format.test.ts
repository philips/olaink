import { describe, expect, it } from 'vitest';
import { formatBytes, formatClock, formatDay } from './format';

describe('format helpers', () => {
  it('formats sizes in KB below 1 MiB and MB above, never 0 KB', () => {
    expect(formatBytes(1)).toBe('1 KB');
    expect(formatBytes(300 * 1024)).toBe('300 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(Number.NaN)).toBe('');
  });

  it('formats UTC time and day', () => {
    const at = Date.UTC(2026, 9, 17, 17, 19, 40);
    expect(formatClock(at)).toBe('17:19:40');
    expect(formatDay(at)).toBe('2026-10-17');
    expect(formatDay(0)).toBe('');
    expect(formatDay(Number.NaN)).toBe('');
  });
});
