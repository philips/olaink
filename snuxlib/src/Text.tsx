import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { theme } from './theme';

type Props = { children: React.ReactNode; selectable?: boolean };

/** Small grey heading that starts a group inside a pane ("Muted users (0)"). */
export function SectionLabel({ children }: Props) {
  return <Text style={styles.section}>{children}</Text>;
}

/** Normal paragraph text. */
export function BodyText({ children, selectable }: Props) {
  return <Text selectable={selectable === true} style={styles.body}>{children}</Text>;
}

/** What a pane says when there is nothing to list. */
export function EmptyText({ children }: Props) {
  return <Text style={styles.empty}>{children}</Text>;
}

/** Small grey line for an inline result or error right next to the control that caused it. */
export function StatusText({ children, selectable }: Props) {
  return <Text selectable={selectable !== false} style={styles.status}>{children}</Text>;
}

/** Monospace block for keys, ids and log lines; selectable. */
export function MonoText({ children }: Props) {
  return <Text selectable style={styles.mono}>{children}</Text>;
}

const { color, font } = theme;
const styles = StyleSheet.create({
  section: { color: color.muted, fontSize: font.section, marginTop: 34, marginBottom: 6 },
  body: { color: color.ink, fontSize: font.body, lineHeight: 32, marginTop: 14 },
  empty: { color: color.subtle, fontSize: font.body, lineHeight: 32, marginTop: 30 },
  status: { color: color.muted, fontSize: font.meta, lineHeight: 26, marginTop: 20 },
  mono: { color: '#333', fontSize: font.mono - 1, lineHeight: 22, fontFamily: 'monospace', marginTop: 4, marginBottom: 14 },
});
