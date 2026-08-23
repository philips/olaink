/** SwapNote configuration and pending-pages inbox view. */

import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import type { CoreState } from './src/core/wrtnCore.ts';
import { getCore, startSwapNote } from './src/headless.ts';
import { getPluginViewMode, setPluginViewMode, type PluginViewMode } from './src/viewMode.ts';

const PHASE_LABEL: Record<CoreState['phase'], string> = {
  starting: 'starting…', offline: 'offline', connecting: 'connecting…', connected: 'connected', closed: 'closed',
};

export default function App(): React.ReactElement {
  const [state, setState] = useState<CoreState>(getCore().state);
  const [viewMode, setViewMode] = useState<PluginViewMode>(getPluginViewMode);
  const [recipient, setRecipient] = useState('');
  const [server, setServer] = useState<string | null>(null);

  useEffect(() => {
    const core = getCore();
    void startSwapNote();
    const unsubscribe = core.subscribe(() => setState({ ...core.state }));
    setState({ ...core.state });
    return unsubscribe;
  }, []);

  const core = getCore();
  const shownServer = server ?? state.serverUrl;
  const send = (): void => {
    void core.sendCurrentPage(recipient).then((sent) => { if (sent) setRecipient(''); })
      .catch((error: Error) => console.log(`[wrtn] send failed: ${error.message}`));
  };
  const showConfig = (): void => { setPluginViewMode('config'); setViewMode('config'); };
  const showInbox = (): void => { setPluginViewMode('inbox'); setViewMode('inbox'); };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable style={styles.back} onPress={() => PluginManager.closePluginView()}><Text style={styles.backText}>‹ note</Text></Pressable>
        <Text style={styles.title}>{viewMode === 'inbox' ? 'SwapNote inbox' : 'SwapNote'}</Text>
        <Text style={[styles.phase, state.phase === 'connected' ? styles.ok : styles.dim]}>{PHASE_LABEL[state.phase]}</Text>
      </View>
      {viewMode === 'inbox' ? (
        <Inbox state={state} onShowConfig={showConfig} />
      ) : (
        <Config
          state={state}
          recipient={recipient}
          server={shownServer}
          onRecipientChange={setRecipient}
          onServerChange={setServer}
          onSend={send}
          onSaveServer={() => void core.setServerUrl(shownServer)}
          onShowInbox={showInbox}
        />
      )}
      <Text style={styles.footHint}>“‹ note” returns to your note and stops delivery.</Text>
    </View>
  );
}

function Inbox({ state, onShowConfig }: { state: CoreState; onShowConfig(): void }): React.ReactElement {
  return (
    <ScrollView style={styles.body}>
      <Text style={styles.inboxIntro}>Pending SwapNotes are appended when you open the matching note in INBOX.</Text>
      <Text style={styles.label}>Pending notes · {state.pagePending}</Text>
      {state.pagePendingBySender.length === 0 ? (
        <Text style={styles.dim}>No pending pages. SwapNote is checking for deliveries.</Text>
      ) : state.pagePendingBySender.map((item) => (
        <View key={item.sender} style={styles.noteCard}>
          <Text style={styles.noteName}>swapnote-{item.sender}.note</Text>
          <Text style={styles.value}>{item.count} unread page{item.count === 1 ? '' : 's'}</Text>
          <Text style={styles.hint}>Open this note from INBOX to append the page{item.count === 1 ? '' : 's'}.</Text>
        </View>
      ))}
      <Text style={styles.label}>Connection</Text>
      <Text style={styles.value}>{state.username || '…'}</Text>
      <Text style={styles.hint}>{PHASE_LABEL[state.phase]}</Text>
      <Pressable style={styles.settingsButton} onPress={onShowConfig}><Text style={styles.buttonText}>Settings</Text></Pressable>
    </ScrollView>
  );
}

function Config(props: {
  state: CoreState;
  recipient: string;
  server: string;
  onRecipientChange(value: string): void;
  onServerChange(value: string): void;
  onSend(): void;
  onSaveServer(): void;
  onShowInbox(): void;
}): React.ReactElement {
  const { state, recipient, server, onRecipientChange, onServerChange, onSend, onSaveServer, onShowInbox } = props;
  return (
    <ScrollView style={styles.body}>
      <Text style={styles.label}>You are</Text>
      <Text style={styles.value}>{state.username || '…'}</Text>
      <Pressable style={styles.settingsButton} onPress={onShowInbox}><Text style={styles.buttonText}>Inbox</Text></Pressable>

      <Text style={styles.label}>Send current page</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} value={recipient} onChangeText={onRecipientChange} placeholder="recipient username" placeholderTextColor="#999999" autoCapitalize="none" autoCorrect={false} />
        <Pressable style={styles.button} onPress={onSend}><Text style={styles.buttonText}>Send</Text></Pressable>
      </View>
      <Text style={styles.hint}>Sends the page of the note you have open. The recipient may be offline; it will arrive in their swapnote-&lt;you&gt;.note in INBOX.</Text>

      <Text style={styles.label}>Pages from others · {state.pagePending}</Text>
      {state.pagePendingBySender.length === 0 ? (
        <Text style={styles.dim}>none — open a sender’s swapnote-&lt;them&gt;.note in INBOX to append waiting pages</Text>
      ) : state.pagePendingBySender.map((item) => (
        <Text key={item.sender} style={styles.value}>{item.sender}: {item.count} page(s) waiting in swapnote-{item.sender}.note</Text>
      ))}

      <Text style={styles.label}>Server</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} value={server} onChangeText={onServerChange} placeholder="https://host.tailnet.ts.net" placeholderTextColor="#999999" autoCapitalize="none" autoCorrect={false} />
        <Pressable style={styles.button} onPress={onSaveServer}><Text style={styles.buttonText}>Save</Text></Pressable>
      </View>
      <Text style={styles.hint}>Applies after reopening the plugin.</Text>
      {state.storeError !== null ? <Text style={styles.warn}>⚠ {state.storeError}</Text> : null}

      <Text style={styles.label}>Activity · pages sent {state.sent}</Text>
      {state.log.slice(-8).map((line, index) => <Text key={index} style={styles.log}>{line}</Text>)}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#000000' },
  title: { fontSize: 28, fontWeight: '700', color: '#000000' }, back: { paddingVertical: 6, paddingRight: 12 }, backText: { fontSize: 20, color: '#000000' }, phase: { fontSize: 16, color: '#000000' },
  body: { flex: 1, paddingHorizontal: 24, paddingVertical: 12 }, label: { fontSize: 14, color: '#666666', marginTop: 16, marginBottom: 4, textTransform: 'uppercase' }, value: { fontSize: 20, color: '#000000', marginVertical: 2 }, dim: { fontSize: 16, color: '#888888' }, ok: { fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 }, input: { flex: 1, fontSize: 18, color: '#000000', borderWidth: 1, borderColor: '#000000', paddingHorizontal: 10, paddingVertical: 8 }, button: { borderWidth: 1, borderColor: '#000000', paddingHorizontal: 16, paddingVertical: 10 }, buttonText: { fontSize: 18, color: '#000000' }, hint: { fontSize: 13, color: '#888888', marginTop: 4 }, warn: { fontSize: 14, color: '#000000', marginTop: 4 }, log: { fontSize: 13, color: '#444444', fontFamily: 'monospace' }, footHint: { fontSize: 13, color: '#888888', textAlign: 'center', marginHorizontal: 24, marginVertical: 10 },
  inboxIntro: { fontSize: 18, color: '#000000', marginTop: 8 }, noteCard: { borderWidth: 1, borderColor: '#000000', padding: 14, marginVertical: 6 }, noteName: { fontSize: 18, fontWeight: '700', color: '#000000' }, settingsButton: { alignSelf: 'flex-start', borderWidth: 1, borderColor: '#000000', paddingHorizontal: 16, paddingVertical: 10, marginTop: 24 },
});
