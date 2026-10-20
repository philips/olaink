import React from 'react';
import { StyleSheet, View } from 'react-native';
import { theme } from './theme';

/**
 * A dashed horizontal rule, the separator between list rows and sidebar tabs.
 * Drawn with small Views: Android ignores `borderStyle: 'dashed'` when only
 * one side has a border.
 */
export function Dashes() {
  return <View style={styles.dashes}>{Array.from({ length: 200 }, (_, i) => <View key={i} style={styles.dash} />)}</View>;
}

/** A solid 1-unit rule (used under a header row or to end a group). */
export function Rule() {
  return <View style={styles.rule} />;
}

const styles = StyleSheet.create({
  dashes: { flexDirection: 'row', overflow: 'hidden', height: 1, marginHorizontal: 10 },
  dash: { width: 4, height: 1, marginRight: 4, backgroundColor: theme.color.rule },
  rule: { height: 1, backgroundColor: theme.color.ink },
});
