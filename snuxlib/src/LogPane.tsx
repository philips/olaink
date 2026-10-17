import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { SecondaryButton } from './Buttons';
import { formatClock } from './format';
import type { LogEntry } from './log';
import { EmptyText, SectionLabel } from './Text';
import { theme } from './theme';

export interface LogPaneProps {
  /** From `useLog().entries` (oldest first; shown newest first). */
  entries: readonly LogEntry[];
  /** From `useLog().clear`. */
  onClear: () => void;
  /** Fixed facts for a bug report: version, device id, user, API level... One per line. */
  diagnostics?: readonly string[];
  /** Replaces the default "Send a screenshot of this page" instruction. */
  hint?: string;
}

/**
 * The content of a Logs tab: a Diagnostics block, then the log newest first
 * with UTC timestamps, and a Clear button. Everything is selectable monospace
 * text. Give users one place to look, and ask them for a screenshot of it.
 */
export function LogPane({ entries, onClear, diagnostics = [], hint }: LogPaneProps) {
  return <>
    <SectionLabel>Diagnostics</SectionLabel>
    <Text selectable style={styles.line}>{diagnostics.join('\n')}</Text>
    <SectionLabel>{`Log (${entries.length})`}</SectionLabel>
    <Text style={styles.hint}>{hint ?? 'Newest first, times in UTC. Send a screenshot of this page when reporting a problem.'}</Text>
    <SecondaryButton label="Clear log" onPress={onClear} />
    {entries.length === 0 && <EmptyText>The log is empty.</EmptyText>}
    {[...entries].reverse().map((entry, index) =>
      <Text key={`${entry.at}-${index}`} selectable style={styles.line}>{`${formatClock(entry.at)}  ${entry.text}`}</Text>)}
  </>;
}

const styles = StyleSheet.create({
  hint: { color: theme.color.ink, fontSize: theme.font.body, lineHeight: 32, marginTop: 14 },
  line: { color: theme.color.soft, fontSize: theme.font.mono, lineHeight: 24, marginTop: 8, fontFamily: 'monospace' },
});
