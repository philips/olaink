/**
 * Measurements and colours copied from the Supernote system Settings screen
 * (1920x2560 at 300 dpi; React Native units are 1.875 device px). Everything
 * here is intentionally fixed: a plugin should look like part of the device,
 * so restyle by composing components, not by editing these numbers.
 */
export const theme = {
  color: {
    /** Text, selection bar, solid rules, primary button fill. */
    ink: '#000',
    paper: '#fff',
    /** Body text on the lighter (secondary) level. */
    soft: '#222',
    /** Section labels, status text. */
    muted: '#555',
    /** Row meta lines, empty-state text. */
    subtle: '#666',
    /** Placeholder text. */
    placeholder: '#9a9a9a',
    /** Dashed list rules and the sidebar divider. */
    rule: '#9a9a9a',
    /** Disabled borders. */
    disabledBorder: '#cccccc',
    /** Destructive confirmation fill. Prefer ink; use sparingly (e-ink greys it). */
    danger: '#a00000',
  },
  size: {
    titleBar: 71,
    sidebarWidth: 294,
    tabHeight: 82,
    rowMinHeight: 82,
    icon: 30,
    chevron: 26,
    paneInset: 29,
  },
  font: {
    title: 24,
    body: 22,
    row: 22,
    action: 20,
    section: 20,
    meta: 18,
    mono: 17,
  },
} as const;
