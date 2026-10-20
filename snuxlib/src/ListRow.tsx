import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Dashes, Rule } from './Dashes';
import { icons } from './icons';
import { theme } from './theme';

export interface ListRowProps {
  title: string;
  /** Grey second line (an id, a date, a sender). */
  meta?: string;
  /** Bold third line for the fact the user decides on (a count, a state). */
  detail?: string;
  /** Makes the row tappable and shows a chevron. Called with no arguments. */
  onPress?: () => void;
  /** Underlined text action on the right (e.g. "Remove") instead of the chevron. Needs `onPress`. */
  action?: string;
  /** End the row with a solid rule instead of a dashed one (use for the last row of a group). */
  solid?: boolean;
}

/**
 * A Settings-style row: title, optional meta and detail lines, chevron or
 * text action, and a separator. Rows without `onPress` are plain information.
 * `onPress` is invoked without the press event, so handlers that take
 * optional arguments are safe to pass directly.
 */
export function ListRow({ title, meta, detail, onPress, action, solid }: ListRowProps) {
  const body = <View style={styles.row}>
    <View style={styles.text}>
      <Text style={styles.title} numberOfLines={2}>{title}</Text>
      {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
      {detail ? <Text style={styles.detail} numberOfLines={1}>{detail}</Text> : null}
    </View>
    {action ? <Text style={styles.action}>{action}</Text>
      : onPress ? <Image source={icons.chevron} style={styles.chevron} /> : null}
  </View>;
  return <View>
    {onPress ? <Pressable onPress={() => onPress()}>{body}</Pressable> : body}
    {solid ? <Rule /> : <Dashes />}
  </View>;
}

const { color, size, font } = theme;
const styles = StyleSheet.create({
  row: { minHeight: size.rowMinHeight, flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  text: { flex: 1 },
  title: { color: color.ink, fontSize: font.row },
  meta: { color: color.subtle, fontSize: font.meta, marginTop: 4 },
  detail: { color: color.ink, fontSize: font.action, fontWeight: '500', marginTop: 4 },
  action: { color: color.ink, fontSize: font.action, textDecorationLine: 'underline' },
  chevron: { width: size.chevron, height: size.chevron },
});
