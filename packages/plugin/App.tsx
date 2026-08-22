/**
 * WRTN setup/status view (shown for the "WRTN Setup" toolbar button).
 *
 * E-ink friendly: black on white, no animations, big touch targets.
 * The live session itself is headless — see index.js. This view binds to
 * the same shared WrtnCore instance started at runtime boot.
 */

import React, { useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import type { CoreState } from './src/core/wrtnCore.ts';
import { getCore, startSession } from './src/headless.ts';

const PHASE_LABEL: Record<CoreState['phase'], string> = {
  starting: 'starting…',
  offline: 'offline',
  connecting: 'connecting…',
  connected: 'connected',
  closed: 'closed',
};

export default function App(): React.ReactElement {
  const [state, setState] = useState<CoreState>(getCore().state);
  const [invite, setInvite] = useState('');
  const [server, setServer] = useState<string | null>(null);

  useEffect(() => {
    const core = getCore();
    void startSession(); // idempotent (runtime may have booted headless)
    const unsub = core.subscribe(() => setState({ ...core.state }));
    setState({ ...core.state });
    return unsub;
  }, []);

  const core = getCore();
  const shownServer = server ?? state.serverUrl;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable style={styles.back} onPress={() => PluginManager.closePluginView()}>
          <Text style={styles.backText}>‹ note</Text>
        </Pressable>
        <Text style={styles.title}>WRTN</Text>
        <Text
          style={[
            styles.phase,
            state.phase === 'connected' ? styles.ok : styles.dim,
          ]}>
          {PHASE_LABEL[state.phase]}
        </Text>
      </View>

      <ScrollView style={styles.body}>
        <Text style={styles.label}>You are</Text>
        <Text style={styles.value}>{state.username || '…'}</Text>

        <Text style={styles.label}>Session members</Text>
        {state.members.length === 0 ? (
          <Text style={styles.dim}>nobody yet — invite someone below</Text>
        ) : (
          state.members.map(m => (
            <Text key={m.username} style={styles.value}>
              {m.username}
              {m.virtual ? '  (bot)' : ''}
            </Text>
          ))
        )}

        <Text style={styles.label}>Invite by username</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={invite}
            onChangeText={setInvite}
            placeholder="e.g. echo"
            placeholderTextColor="#999999"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            style={styles.button}
            onPress={() => {
              core.addUser(invite);
              setInvite('');
            }}>
            <Text style={styles.buttonText}>Invite</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          Tip: invite “echo” to test — it draws your strokes back, offset and
          gray.
        </Text>

        <Text style={styles.label}>Server</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={shownServer}
            onChangeText={setServer}
            placeholder="https://host.tailnet.ts.net"
            placeholderTextColor="#999999"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            style={styles.button}
            onPress={() => void core.setServerUrl(shownServer)}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>Applies after reopening the plugin.</Text>
        {state.storeError !== null ? (
          <Text style={styles.warn}>⚠ {state.storeError}</Text>
        ) : null}

        <Text style={styles.label}>
          Pending from others · {state.pending}
        </Text>
        <View style={styles.row}>
          <Pressable
            style={styles.button}
            onPress={() => void core.pullPending().catch((e: Error) => console.log(`[wrtn] pull failed: ${e.message}`))}>
            <Text style={styles.buttonText}>Pull now</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          Remote strokes queue up without redrawing your note; pulling
          applies them to the current page (one screen flash per pull).
          The WRTN Pull toolbar button in your note does the same.
        </Text>

        <Text style={styles.label}>
          Activity · sent {state.sent} · received {state.received}
        </Text>
        {state.log.slice(-8).map((line, i) => (
          <Text key={i} style={styles.log}>
            {line}
          </Text>
        ))}
      </ScrollView>

      <Text style={styles.footHint}>
        “‹ note” returns to your note and stops this session — restart it any
        time from the WRTN toolbar button. Tap WRTN Pull to fetch pending
        strokes.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#000000',
  },
  title: { fontSize: 28, fontWeight: '700', color: '#000000' },
  back: { paddingVertical: 6, paddingRight: 12 },
  backText: { fontSize: 20, color: '#000000' },
  phase: { fontSize: 16, color: '#000000' },
  body: { flex: 1, paddingHorizontal: 24, paddingVertical: 12 },
  label: {
    fontSize: 14,
    color: '#666666',
    marginTop: 16,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  value: { fontSize: 20, color: '#000000', marginVertical: 2 },
  dim: { fontSize: 16, color: '#888888' },
  ok: { fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    fontSize: 18,
    color: '#000000',
    borderWidth: 1,
    borderColor: '#000000',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  button: {
    borderWidth: 1,
    borderColor: '#000000',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  buttonText: { fontSize: 18, color: '#000000' },
  hint: { fontSize: 13, color: '#888888', marginTop: 4 },
  warn: { fontSize: 14, color: '#000000', marginTop: 4 },
  log: { fontSize: 13, color: '#444444', fontFamily: 'monospace' },
  footHint: {
    fontSize: 13,
    color: '#888888',
    textAlign: 'center',
    marginHorizontal: 24,
    marginVertical: 10,
  },
});
