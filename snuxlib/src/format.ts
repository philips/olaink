/** "12 KB" / "1.4 MB"; empty string for a non-finite size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** UTC wall clock, "17:19:40". UTC on purpose: users paste logs to developers. */
export function formatClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/** UTC calendar day, "2026-10-17"; empty string for a missing/invalid time. */
export function formatDay(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '';
}
