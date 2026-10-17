import React from 'react';
import { StyleSheet, TextInput, type KeyboardTypeOptions } from 'react-native';
import { theme } from './theme';

export interface TextFieldProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
}

/**
 * Underlined single-line input. Autocorrect and auto-capitalisation are off
 * (these fields hold codes, ids and usernames). Put it near the top of the
 * pane: the on-screen keyboard covers the lower half of the screen.
 */
export function TextField({ value, onChangeText, placeholder, keyboardType }: TextFieldProps) {
  return <TextInput style={styles.input} value={value} onChangeText={onChangeText}
    placeholder={placeholder} placeholderTextColor={theme.color.placeholder}
    {...(keyboardType ? { keyboardType } : {})} autoCorrect={false} autoCapitalize="none" />;
}

const styles = StyleSheet.create({
  input: { borderBottomWidth: 1, borderBottomColor: theme.color.ink, marginTop: 14, paddingHorizontal: 0, paddingVertical: 12, color: theme.color.ink, fontSize: theme.font.body },
});
