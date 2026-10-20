import { useCallback, useState } from 'react';
import { appendLog, DEFAULT_MAX_LOG_ENTRIES, type LogEntry } from './log';

export interface UseLogOptions {
  /** Lines to keep (default 200). */
  max?: number;
  /** First line, e.g. 'Loading…'. */
  initial?: string;
  /** If set, every line is also `console.log`ged as `[prefix] text` (shows in logcat as ReactNativeJS). */
  prefix?: string;
}

/**
 * An in-memory, append-only log for a plugin. Plugins cannot be inspected
 * from a shell on the device, so route every status, result and error here
 * and show it with `<LogPane>` on a Logs tab: a screenshot of that tab is
 * then enough to debug a user's problem.
 *
 * `log` is stable-safe to call from any callback or effect (it uses a
 * functional state update) and ignores empty strings, so `.then(log)` works.
 */
export function useLog(options: UseLogOptions = {}) {
  const { max = DEFAULT_MAX_LOG_ENTRIES, initial, prefix } = options;
  const [entries, setEntries] = useState<LogEntry[]>(() => (initial ? [{ at: Date.now(), text: initial }] : []));
  const log = useCallback((text: string) => {
    if (!text) return;
    if (prefix) console.log(`[${prefix}] ${text}`);
    setEntries(previous => appendLog(previous, text, Date.now(), max));
  }, [max, prefix]);
  const clear = useCallback(() => setEntries([]), []);
  return { entries, log, clear };
}
