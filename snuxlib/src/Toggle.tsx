import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from './theme';

export interface ToggleProps {
  label: string;
  /** Explanation under the label; also where a locked toggle says why. */
  subtext?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  /** Locked: dashed, grey, and ignores taps. */
  disabled?: boolean;
}

/**
 * On/off control for e-ink. The platform Switch is about 30x36 px on a
 * 1920 px wide Nomad screen: hard to see and hard to hit. This is a large
 * bordered row (the whole row is the touch target) whose state is a big
 * ON/OFF pill, black when on, instead of a knob position.
 */
export function Toggle({ label, subtext, value, onChange, disabled }: ToggleProps) {
  return <Pressable
    onPress={() => onChange(!value)}
    disabled={disabled === true}
    accessibilityRole="switch"
    accessibilityLabel={label}
    accessibilityState={{ checked: value, disabled: disabled === true }}
    style={[styles.row, disabled && styles.rowLocked]}>
    <View style={styles.text}>
      <Text style={[styles.label, disabled && styles.lockedText]}>{label}</Text>
      {subtext ? <Text style={styles.subtext}>{subtext}</Text> : null}
    </View>
    <View style={[styles.pill, value ? styles.pillOn : styles.pillOff, disabled && styles.pillLocked]}>
      <Text style={[styles.pillText, value ? styles.pillTextOn : styles.pillTextOff, disabled && styles.lockedText]}>
        {value ? 'ON' : 'OFF'}
      </Text>
    </View>
  </Pressable>;
}

const { color, font } = theme;
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 2, borderColor: color.ink, paddingVertical: 18, paddingHorizontal: 20, minHeight: 104, marginTop: 14 },
  rowLocked: { borderStyle: 'dashed', borderColor: color.disabledBorder },
  text: { flex: 1, paddingRight: 20 },
  label: { fontSize: font.body, fontWeight: '700', color: color.ink },
  subtext: { fontSize: font.meta, color: color.muted, marginTop: 4 },
  lockedText: { color: color.muted },
  pill: { minWidth: 120, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  pillOn: { backgroundColor: color.ink, borderColor: color.ink },
  pillOff: { backgroundColor: color.paper, borderColor: color.ink },
  pillLocked: { borderStyle: 'dashed', borderColor: color.disabledBorder, backgroundColor: color.paper },
  pillText: { fontSize: font.body, fontWeight: '700' },
  pillTextOn: { color: color.paper },
  pillTextOff: { color: color.ink },
});
