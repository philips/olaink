import React, { useEffect, useState } from 'react';
import { NativeModules, Pressable, requireNativeComponent, ScrollView, StyleSheet, Text, View } from 'react-native';
import { PluginCommAPI, PluginManager } from 'sn-plugin-lib';

const probe = NativeModules.OlaInkProbe;
const ProbeWebView = requireNativeComponent('OlaInkProbeWebView');
const PERMISSIONS = [
  ['plugin.permission.FILE:READ', 'Allow note read'],
  ['plugin.permission.FILE:WRITE', 'Allow Note-folder write'],
  ['plugin.permission.INTERNET', 'Allow HTTPS'],
];

function message(error) {
  return error?.message || String(error);
}

export default function App() {
  const [status, setStatus] = useState('Loading OlaInkProbe native module…');
  const [permissions, setPermissions] = useState('Checking permissions…');
  const [showWebView, setShowWebView] = useState(false);

  const inspect = () => {
    if (!probe?.describe) {
      setStatus('FAIL: NativeModules.OlaInkProbe is unavailable. Check reactPackages and app.npk.');
      return;
    }
    void probe.describe()
      .then(result => setStatus(`OK r${result.probeRevision}: ${result.packageName}; native package loaded.`))
      .catch(error => setStatus(`FAIL: ${message(error)}`));
  };

  const inspectPermissions = () => {
    void Promise.all(PERMISSIONS.map(async ([permission]) => [permission, await PluginManager.hasPermission(permission)]))
      .then(results => setPermissions(results.map(([permission, value]) => `${permission.replace('plugin.permission.', '')}=${value}`).join('  ')))
      .catch(error => setPermissions(`FAIL: ${message(error)}`));
  };

  const request = permission => {
    setStatus(`Awaiting consent for ${permission.replace('plugin.permission.', '')}…`);
    void PluginManager.requestPermission(permission, 'This disposable probe is testing PluginHost scoped permission behavior.')
      .then(value => {
        setStatus(`${permission.replace('plugin.permission.', '')} request returned ${value}.`);
        inspectPermissions();
      })
      .catch(error => setStatus(`FAIL: ${message(error)}`));
  };

  const readCurrentNote = () => {
    if (!probe?.openCurrentNote) return setStatus('FAIL: native read method unavailable.');
    setStatus('Obtaining the active NOTE path; no path or bytes will be displayed.');
    void PluginCommAPI.getCurrentFilePath()
      .then(response => {
        const path = response?.success ? response.result : null;
        if (typeof path !== 'string' || !path) throw new Error('current NOTE path unavailable');
        return probe.openCurrentNote(path);
      })
      .then(result => setStatus(`Native direct note open succeeded (${result.size} bytes; no content returned).`))
      .catch(error => setStatus(`Native direct note open failed: ${message(error)}`));
  };

  const writeFixture = () => {
    if (!probe?.writeNoteFixture) return setStatus('FAIL: native write method unavailable.');
    setStatus('Writing the harmless Note-folder permission marker…');
    void probe.writeNoteFixture()
      .then(result => setStatus(`Native direct write succeeded: ${result.filename} (${result.size} bytes). Developer ADB cleanup removes it.`))
      .catch(error => setStatus(`Native direct write failed: ${message(error)}`));
  };

  const requestHttps = () => {
    if (!probe?.requestHttps) return setStatus('FAIL: native HTTPS method unavailable.');
    setStatus('Making a HEAD request to app.olaink.com; no account or note data is sent.');
    void probe.requestHttps()
      .then(result => setStatus(`Native HTTPS succeeded (HTTP ${result.status}).`))
      .catch(error => setStatus(`Native HTTPS failed: ${message(error)}`));
  };

  useEffect(() => {
    inspect();
    inspectPermissions();
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.title}>Ola Ink scoped-permission probe</Text>
      <Text style={styles.copy}>Phase 0.2 only. It tests PluginHost consent plus bounded direct Java I/O. It never returns a note path or note bytes, creates no key, and makes only an unauthenticated HTTPS HEAD request.</Text>
      <Pressable style={styles.button} onPress={inspect}>
        <Text style={styles.buttonText}>Run native-module check</Text>
      </Pressable>
      <Text selectable style={styles.permissions}>{permissions}</Text>
      {PERMISSIONS.map(([permission, label]) => (
        <Pressable key={permission} style={styles.button} onPress={() => request(permission)}>
          <Text style={styles.buttonText}>{label}</Text>
        </Pressable>
      ))}
      <View style={styles.divider} />
      <Pressable style={styles.button} onPress={() => setShowWebView(true)}>
        <Text style={styles.buttonText}>Mount local HTTPS WebView probe</Text>
      </Pressable>
      {showWebView && (
        <View style={styles.webViewFrame}>
          <ProbeWebView style={styles.webView} />
        </View>
      )}
      <Pressable style={styles.button} onPress={readCurrentNote}>
        <Text style={styles.buttonText}>Open current NOTE in native Java</Text>
      </Pressable>
      <Pressable style={styles.button} onPress={writeFixture}>
        <Text style={styles.buttonText}>Write harmless Note-folder marker</Text>
      </Pressable>
      <Pressable style={styles.button} onPress={requestHttps}>
        <Text style={styles.buttonText}>Make native HTTPS HEAD request</Text>
      </Pressable>
      <Text selectable style={styles.status}>{status}</Text>
      <Pressable style={styles.close} onPress={() => PluginManager.closePluginView()}>
        <Text style={styles.closeText}>Close</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, padding: 24, backgroundColor: '#f7f4ed' },
  title: { color: '#000000', fontSize: 27, fontWeight: '700' },
  copy: { color: '#28251f', fontSize: 18, lineHeight: 26, marginTop: 20 },
  button: { alignSelf: 'flex-start', borderColor: '#000000', borderWidth: 1, marginTop: 14, paddingHorizontal: 18, paddingVertical: 13 },
  buttonText: { color: '#000000', fontSize: 17 },
  permissions: { color: '#28251f', fontSize: 14, lineHeight: 21, marginTop: 22 },
  divider: { borderTopColor: '#9b968c', borderTopWidth: 1, marginTop: 24 },
  webViewFrame: { borderColor: '#000000', borderWidth: 1, height: 500, marginTop: 16, width: '100%' },
  webView: { flex: 1 },
  status: { color: '#28251f', fontSize: 15, lineHeight: 22, marginTop: 22 },
  close: { alignSelf: 'flex-start', marginTop: 28, paddingVertical: 8 },
  closeText: { color: '#000000', fontSize: 18, textDecorationLine: 'underline' },
});
