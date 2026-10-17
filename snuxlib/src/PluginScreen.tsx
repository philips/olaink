import React from 'react';
import { Image, type ImageSourcePropType, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Dashes } from './Dashes';
import { icons } from './icons';
import { theme } from './theme';

/** One entry of the vertical tab menu. */
export interface TabSpec {
  /** Stable id; compare with `PluginScreen.activeKey`. */
  key: string;
  label: string;
  /** A `require()`d image or one of `icons`. */
  icon: ImageSourcePropType;
  /** Called with no arguments. */
  onPress: () => void;
  /** Pin to the bottom of the sidebar (like InkHub's Upload / username group). */
  bottom?: boolean;
}

export interface PluginScreenProps {
  /** App name shown next to the close button in the black title bar. */
  appName: string;
  /** Title of the current pane, centred in the title bar. */
  title: string;
  /** Close the plugin, normally `() => PluginManager.closePluginView()`. */
  onClose: () => void;
  tabs: TabSpec[];
  /** The `key` of the selected tab. */
  activeKey: string;
  /** Pane content; it scrolls. */
  children?: React.ReactNode;
}

/**
 * The whole-screen frame, modelled on the Supernote system Settings app: a
 * black title bar (close button and app name on the left, pane title in the
 * middle), a vertical tab menu on the left with a thick selection bar, and a
 * scrolling white content pane. Render it as the root of your plugin.
 *
 * Tabs with `bottom: true` are pinned to the bottom of the menu, after the
 * rest. Typical use: the account/username tab, as in InkHub.
 */
export function PluginScreen({ appName, title, onClose, tabs, activeKey, children }: PluginScreenProps) {
  const renderTab = (tab: TabSpec) =>
    <SideTab key={tab.key} label={tab.label} icon={tab.icon} active={tab.key === activeKey} onPress={tab.onPress} />;
  return <View style={styles.screen}>
    <View style={styles.header}>
      <Pressable style={styles.headerLeft} onPress={() => onClose()} accessibilityLabel={`Close ${appName}`}>
        <Image source={icons.close} style={styles.headerIcon} />
        <Text style={styles.headerTitle}>{appName}</Text>
      </Pressable>
      <Text style={styles.headerCenter} numberOfLines={1}>{title}</Text>
    </View>
    <View style={styles.body}>
      <View style={styles.sidebar}>
        <View>{tabs.filter(tab => !tab.bottom).map(renderTab)}</View>
        <View>{tabs.filter(tab => tab.bottom).map(renderTab)}</View>
      </View>
      <ScrollView style={styles.pane} contentContainerStyle={styles.paneContent} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </View>
  </View>;
}

export interface SideTabProps {
  label: string;
  icon: ImageSourcePropType;
  active: boolean;
  onPress: () => void;
}

/** One row of the tab menu. Use `PluginScreen`'s `tabs` unless you build your own frame. */
export function SideTab({ label, icon, active, onPress }: SideTabProps) {
  return <Pressable onPress={() => onPress()} accessibilityRole="tab" accessibilityState={{ selected: active }}>
    <View style={styles.sideTab}>
      <Image source={icon} style={styles.sideIcon} />
      <Text style={styles.sideLabel} numberOfLines={1}>{label}</Text>
      {active && <View style={styles.sideSelected} />}
    </View>
    <Dashes />
  </Pressable>;
}

const { color, size, font } = theme;
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  header: { height: size.titleBar, backgroundColor: color.ink, flexDirection: 'row', alignItems: 'center' },
  headerLeft: { width: size.sidebarWidth, height: size.titleBar, flexDirection: 'row', alignItems: 'center', paddingLeft: 22 },
  headerIcon: { width: size.icon, height: size.icon },
  headerTitle: { color: color.paper, fontSize: font.title, fontWeight: '500', marginLeft: 22 },
  headerCenter: { flex: 1, color: color.paper, fontSize: font.title, fontWeight: '500', textAlign: 'center', paddingHorizontal: 24 },
  body: { flex: 1, flexDirection: 'row' },
  sidebar: { width: size.sidebarWidth, borderRightWidth: 1, borderRightColor: color.rule, justifyContent: 'space-between' },
  sideTab: { height: size.tabHeight, flexDirection: 'row', alignItems: 'center', paddingLeft: 22 },
  sideIcon: { width: size.icon, height: size.icon },
  sideLabel: { flex: 1, color: color.ink, fontSize: font.body, marginLeft: 25, marginRight: 14 },
  sideSelected: { position: 'absolute', right: -1, top: 0, bottom: 0, width: 5, backgroundColor: color.ink },
  pane: { flex: 1 },
  paneContent: { paddingHorizontal: size.paneInset, paddingBottom: 48 },
});
