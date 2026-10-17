/** One line of the in-app log. */
export interface LogEntry {
  /** Epoch milliseconds. */
  at: number;
  text: string;
}

/** Default number of lines kept in memory. */
export const DEFAULT_MAX_LOG_ENTRIES = 200;

/**
 * Returns `entries` with `text` appended (oldest first), trimmed to the last
 * `max` lines. Empty text is ignored. Pure, so it is easy to test.
 */
export function appendLog(entries: readonly LogEntry[], text: string, at: number, max = DEFAULT_MAX_LOG_ENTRIES): LogEntry[] {
  if (!text) return entries.slice();
  return [...entries, { at, text }].slice(-Math.max(1, max));
}
