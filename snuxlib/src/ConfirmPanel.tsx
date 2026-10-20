import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from './theme';

export interface ConfirmPanelProps {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The confirming action is the risky one (remove, disconnect, log out). */
  destructive?: boolean;
}

/**
 * Confirmation shown inside the screen instead of the platform `Alert`. The
 * native dialog renders tiny on the Nomad (about 25 px tall text buttons in
 * low-contrast colour); this uses large black-and-white buttons. Render it
 * in the pane, right below the thing being confirmed, and hide it again on
 * confirm or cancel.
 */
export function ConfirmPanel({ title, message, confirmLabel, onConfirm, onCancel, destructive }: ConfirmPanelProps) {
  return <View style={styles.panel} accessibilityRole="alert">
    <Text style={styles.title}>{title}</Text>
    <Text style={styles.message}>{message}</Text>
    <View style={styles.buttons}>
      <Pressable style={[styles.button, styles.cancel]} onPress={() => onCancel()} accessibilityRole="button">
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
      <Pressable style={[styles.button, destructive ? styles.confirmDanger : styles.confirm]}
        onPress={() => onConfirm()} accessibilityRole="button">
        <Text style={styles.confirmText}>{confirmLabel}</Text>
      </Pressable>
    </View>
  </View>;
}

const { color, font } = theme;
const styles = StyleSheet.create({
  panel: { borderWidth: 4, borderColor: color.ink, padding: 20, marginTop: 14, backgroundColor: color.paper },
  title: { fontSize: font.body, fontWeight: '700', color: color.ink },
  message: { fontSize: font.action, color: color.ink, marginTop: 6, marginBottom: 16 },
  buttons: { flexDirection: 'row', justifyContent: 'space-between' },
  button: { flex: 1, minHeight: 84, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  cancel: { marginRight: 12, borderColor: color.ink, backgroundColor: color.paper },
  confirm: { marginLeft: 12, borderColor: color.ink, backgroundColor: color.ink },
  confirmDanger: { marginLeft: 12, borderColor: color.danger, backgroundColor: color.danger },
  cancelText: { fontSize: font.body, fontWeight: '700', color: color.ink },
  confirmText: { fontSize: font.body, fontWeight: '700', color: color.paper },
});
