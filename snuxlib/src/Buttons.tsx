import React, { createContext, useContext } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from './theme';

/** True inside a ButtonRow, which supplies the vertical spacing itself. */
const InRow = createContext(false);

export interface ButtonProps {
  label: string;
  /** Called with no arguments. */
  onPress: () => void;
}

/** The main action of a pane: solid black, white label. One per decision. */
export function PrimaryButton({ label, onPress }: ButtonProps) {
  const inRow = useContext(InRow);
  return <Pressable style={[styles.primary, inRow && styles.inRow]} onPress={() => onPress()} accessibilityRole="button">
    <Text style={styles.primaryText}>{label}</Text>
  </Pressable>;
}

/** A secondary or cancelling action: outlined, black label. */
export function SecondaryButton({ label, onPress }: ButtonProps) {
  const inRow = useContext(InRow);
  return <Pressable style={[styles.secondary, inRow && styles.inRow]} onPress={() => onPress()} accessibilityRole="button">
    <Text style={styles.secondaryText}>{label}</Text>
  </Pressable>;
}

/**
 * Lays buttons out side by side and wraps them on a narrow pane. Use it
 * whenever two or more buttons belong together. (Android drops the top margin
 * of children in a wrapping row, so the row owns the spacing above them.)
 */
export function ButtonRow({ children }: { children: React.ReactNode }) {
  return <InRow.Provider value><View style={styles.row}>{children}</View></InRow.Provider>;
}

const { color, font } = theme;
const styles = StyleSheet.create({
  primary: { alignSelf: 'flex-start', minWidth: 220, backgroundColor: color.ink, borderRadius: 6, marginTop: 26, marginRight: 18, paddingHorizontal: 32, paddingVertical: 16, alignItems: 'center' },
  primaryText: { color: color.paper, fontSize: font.body, fontWeight: '500' },
  secondary: { alignSelf: 'flex-start', minWidth: 160, borderColor: color.ink, borderWidth: 1.5, borderRadius: 6, marginTop: 26, marginRight: 18, paddingHorizontal: 30, paddingVertical: 15, alignItems: 'center' },
  secondaryText: { color: color.ink, fontSize: font.body },
  row: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 26 },
  inRow: { marginTop: 0 },
});
