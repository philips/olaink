import React, { useState } from 'react';
import { NativeModules, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';

const hostile = NativeModules.OlaInkHostileProbe;

function errorMessage(error) {
  return error?.message || String(error);
}

export default function App() {
  const [result, setResult] = useState('Hostile probe results appear here.');

  const run = (label, method) => {
    if (!hostile?.[method]) {
      setResult(`${label}: FAIL method unavailable`);
      return;
    }
    setResult(`${label}: running…`);
    void hostile[method]()
      .then(value => setResult(`${label}: ${JSON.stringify(value)}`))
      .catch(error => setResult(`${label}: FAIL ${errorMessage(error)}`));
  };

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.eyebrow}>DISPOSABLE · HOSTILE</Text>
      <Text style={styles.title}>Cross-plugin isolation probe</Text>
      <Text style={styles.copy}>
        This plugin deliberately attacks the throwaway E1 state of the Ola Ink native-client
        experiment: its candidate state directories and its Android Keystore wrapping alias. It
        proves or disproves per-plugin isolation inside the shared PluginHost UID. It declares no
        permissions.
      </Text>
      <Pressable style={styles.button} onPress={() => run('Read victim state', 'hostileRead')}>
        <Text style={styles.buttonText}>Try to read victim state files</Text>
      </Pressable>
      <Pressable style={styles.button} onPress={() => run('Detect victim keystore alias', 'hostileKeystoreDetect')}>
        <Text style={styles.buttonText}>Detect + try to use victim keystore alias</Text>
      </Pressable>
      <Pressable style={styles.button} onPress={() => run('Delete victim keystore alias', 'hostileKeystoreDelete')}>
        <Text style={styles.buttonText}>Try to DELETE victim keystore alias (destructive)</Text>
      </Pressable>
      <Text selectable style={styles.result}>{result}</Text>
      <Pressable style={styles.close} onPress={() => PluginManager.closePluginView()}>
        <Text style={styles.closeText}>Close probe</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, padding: 22, backgroundColor: '#f7f4ed' },
  eyebrow: { color: '#7a2020', fontSize: 13, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: '#000000', fontSize: 25, fontWeight: '700', marginTop: 6 },
  copy: { color: '#28251f', fontSize: 16, lineHeight: 23, marginTop: 12 },
  button: { alignSelf: 'flex-start', borderColor: '#000000', borderWidth: 1, marginTop: 14, paddingHorizontal: 14, paddingVertical: 10 },
  buttonText: { color: '#000000', fontSize: 14 },
  result: { color: '#28251f', fontSize: 12, lineHeight: 18, marginTop: 14 },
  close: { alignSelf: 'flex-start', marginTop: 22, paddingVertical: 8 },
  closeText: { color: '#000000', fontSize: 17, textDecorationLine: 'underline' },
});
