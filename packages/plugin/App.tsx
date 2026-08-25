/** OLAINK Share plugin view: launches the companion; it never handles note data. */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import { openCurrentNoteInCompanion } from './src/playerIntent.ts';

export default function App(): React.ReactElement {
  const [status, setStatus] = useState('Open the OLAINK companion to send and receive encrypted notes.');

  const openCompanion = (): void => {
    setStatus('Opening OLAINK companion…');
    void openCurrentNoteInCompanion().then((opened) => {
      setStatus(opened
        ? 'Companion opened with the active-note path. Return to this note when you are finished.'
        : 'The active-note path or OLAINK companion was unavailable.');
    });
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable style={styles.back} onPress={() => PluginManager.closePluginView()}>
          <Text style={styles.backText}>‹ note</Text>
        </Pressable>
        <Text style={styles.title}>OLAINK Share</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.copy}>OLAINK encrypts and plays complete note files in the companion app.</Text>
        <Pressable style={styles.button} onPress={openCompanion}>
          <Text style={styles.buttonText}>Open OLAINK companion</Text>
        </Pressable>
        <Text style={styles.status}>{status}</Text>
        <Text style={styles.hint}>Prototype mode forwards the active-note filesystem path to the companion. It requires developer-enabled all-files access and is not a production-safe hand-off.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff' },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#000000', paddingHorizontal: 24, paddingVertical: 16 },
  back: { paddingVertical: 6, paddingRight: 16 },
  backText: { color: '#000000', fontSize: 20 },
  title: { color: '#000000', fontSize: 28, fontWeight: '700' },
  body: { flex: 1, padding: 24 },
  copy: { color: '#000000', fontSize: 20, lineHeight: 29 },
  button: { alignSelf: 'flex-start', borderColor: '#000000', borderWidth: 1, marginTop: 28, paddingHorizontal: 18, paddingVertical: 13 },
  buttonText: { color: '#000000', fontSize: 18 },
  status: { color: '#333333', fontSize: 16, lineHeight: 23, marginTop: 20 },
  hint: { color: '#777777', fontSize: 14, lineHeight: 20, marginTop: 28 },
});
