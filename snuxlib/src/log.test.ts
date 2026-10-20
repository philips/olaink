import { describe, expect, it } from 'vitest';
import { appendLog, DEFAULT_MAX_LOG_ENTRIES } from './log';

describe('appendLog', () => {
  it('appends oldest first without mutating its input', () => {
    const first = appendLog([], 'one', 1);
    const second = appendLog(first, 'two', 2);
    expect(first).toEqual([{ at: 1, text: 'one' }]);
    expect(second).toEqual([{ at: 1, text: 'one' }, { at: 2, text: 'two' }]);
  });

  it('ignores empty text, so a promise chain can end in .then(log)', () => {
    expect(appendLog([{ at: 1, text: 'a' }], '', 2)).toEqual([{ at: 1, text: 'a' }]);
  });

  it('keeps only the newest max entries', () => {
    let entries = appendLog([], 'a', 1, 3);
    for (const [index, text] of ['b', 'c', 'd', 'e'].entries()) {
      entries = appendLog(entries, text, index + 2, 3);
    }
    expect(entries.map(entry => entry.text)).toEqual(['c', 'd', 'e']);
  });

  it('defaults to 200 lines', () => {
    let entries = appendLog([], 'x', 0);
    for (let index = 1; index < DEFAULT_MAX_LOG_ENTRIES + 50; index += 1) {
      entries = appendLog(entries, String(index), index);
    }
    expect(entries).toHaveLength(DEFAULT_MAX_LOG_ENTRIES);
    expect(entries.at(-1)?.text).toBe(String(DEFAULT_MAX_LOG_ENTRIES + 49));
  });
});
