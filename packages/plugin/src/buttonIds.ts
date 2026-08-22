/**
 * Stable toolbar button ids (kept in sync with the PluginConfig/installer:
 * reusing ids across reinstalls is an in-place upgrade, never a new button).
 * Shared by the RN toolbar wiring (toolbar.ts) and the device bridge
 * (snDevice.ts, which toggles the pull button's enabled state).
 */
export const BUTTON_ID = {
  /** Fullscreen setup/status view (showType 1). */
  setup: 101,
  /** Headless session entry point — boots/keeps the runtime (showType 0). */
  session: 102,
  /** Headless "pull pending strokes" button (showType 0). */
  pull: 103,
} as const;
