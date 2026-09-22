import React, { useEffect, useRef, useState } from 'react';
import { NativeModules, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI } from 'sn-plugin-lib';

const nativeClient = NativeModules.OlaInkNativeClient;
const INTERNET = 'plugin.permission.INTERNET';

const message = error => error?.message || String(error);

export default function App() {
  const [status, setStatus] = useState('Loading file-exchange experiment…');
  const [relay, setRelay] = useState('Relay actions use throwaway E2 staging state only.');
  const [code, setCode] = useState('');
  const [recipient, setRecipient] = useState('e2peer');
  const [fileProbe, setFileProbe] = useState('F0 file-contract results appear here.');
  const [inbox, setInbox] = useState([]);
  // The device session is native-persisted but enters JS only for this foreground
  // React transport session. It is never rendered or placed in AsyncStorage.
  const session = useRef(null);

  const relayPost = async (path, body, sessionToken = null) => {
    const base = await nativeClient.e2RelayBase();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: abort.signal,
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://appassets.androidplatform.net',
          ...(sessionToken ? { 'X-OlaInk-Device-Session': sessionToken } : {}),
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new Error('relay response exceeded size cap');
      const parsed = JSON.parse(text);
      if (!response.ok || !parsed?.ok) throw new Error(`relay returned HTTP ${response.status}`);
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  };

  const currentSession = async () => {
    if (session.current) return session.current;
    const stored = JSON.parse(await nativeClient.e2SessionForReact());
    if (!stored.paired || !stored.sessionToken || !stored.deviceId) throw new Error('device is not paired');
    session.current = stored;
    return stored;
  };

  const claimPairingCode = () => {
    setRelay('Pair: requesting INTERNET…');
    void PluginManager.requestPermission(INTERNET, 'Pair this disposable plugin through the staging relay.')
      .then(async granted => {
        if (!granted) throw new Error('INTERNET was denied');
        const identity = JSON.parse(await nativeClient.e2EnsureIdentity());
        const digits = code.replace(/\D/g, '');
        if (digits.length !== 8) throw new Error('pairing code must contain eight digits');
        const result = await relayPost('/v1/pairings/claim', {
          code: `${digits.slice(0, 4)}-${digits.slice(4)}`,
          device: { deviceId: identity.deviceId, publicKeySpki: identity.publicKeySpki },
        });
        const pairing = result.pairing;
        await nativeClient.e2ApplyReactPairing(pairing.userId, pairing.username || '', pairing.deviceSessionToken);
        session.current = { deviceId: identity.deviceId, userId: pairing.userId,
          username: pairing.username || '', sessionToken: pairing.deviceSessionToken };
        return `Pair: connected as ${pairing.username || 'staging user'}.`;
      })
      .then(setRelay)
      .catch(error => setRelay(`Pair: FAIL ${message(error)}`));
  };

  const refreshInbox = () => {
    setRelay('Inbox: refreshing…');
    void currentSession()
      .then(async active => relayPost('/v1/companion/poll', { deviceId: active.deviceId }, active.sessionToken))
      .then(result => {
        const records = Array.isArray(result.records) ? result.records : [];
        setInbox(records);
        setRelay(`Inbox: ${records.length} encrypted record(s) waiting.`);
      })
      .catch(error => setRelay(`Inbox: FAIL ${message(error)}`));
  };

  const logout = () => {
    setRelay('Logout: ending staging session…');
    void currentSession()
      .then(async active => {
        await relayPost('/v1/companion/logout', { deviceId: active.deviceId }, active.sessionToken);
        await nativeClient.e2ClearLocal();
        session.current = null;
        setInbox([]);
        return 'Logout: local identity and staging session cleared.';
      })
      .then(setRelay)
      .catch(error => setRelay(`Logout: FAIL ${message(error)}`));
  };

  const currentNotePath = async () => {
    const saved = await PluginNoteAPI.saveCurrentNote();
    if (!saved?.success) throw new Error('Supernote did not save the current note');
    const current = await PluginCommAPI.getCurrentFilePath();
    if (!current?.success || typeof current.result !== 'string' || !current.result.endsWith('.note')) {
      throw new Error('Supernote did not provide a current .note path');
    }
    return current.result;
  };

  const inspectCurrentNote = () => {
    setFileProbe('Inspect: requesting FILE:READ…');
    void PluginManager.requestPermission('plugin.permission.FILE:READ',
      'Inspect the saved current note for the disposable F0 file-contract probe.')
      .then(async granted => {
        if (!granted) throw new Error('FILE:READ was denied');
        const path = await currentNotePath();
        return nativeClient.f0InspectCurrentNote(path);
      })
      .then(result => setFileProbe(`Inspect: ${result}`))
      .catch(error => setFileProbe(`Inspect: FAIL ${message(error)}`));
  };

  const sendCurrentNote = () => {
    setFileProbe('Send: requesting FILE:READ…');
    void PluginManager.requestPermission('plugin.permission.FILE:READ',
      'Encrypt and send the saved current note for the disposable F1 probe.')
      .then(async granted => {
        if (!granted) throw new Error('FILE:READ was denied');
        const path = await currentNotePath();
        const active = await currentSession();
        const directoryResult = await relayPost('/v1/companion/directory', {
          deviceId: active.deviceId, username: recipient.trim(),
        }, active.sessionToken);
        const encrypted = JSON.parse(await nativeClient.e2CreateFileRecord(path,
          JSON.stringify(directoryResult.directory)));
        await relayPost('/v1/companion/notes', {
          deviceId: active.deviceId, username: recipient.trim(), record: JSON.parse(encrypted.record),
        }, active.sessionToken);
        return { sent: true, recordId: encrypted.recordId, bytes: encrypted.noteBytes,
          sha256: encrypted.noteSha256, slots: encrypted.slots };
      })
      .then(result => setFileProbe(`Send: ${JSON.stringify(result)}`))
      .catch(error => setFileProbe(`Send: FAIL ${message(error)}`));
  };

  const copyAndOpenCurrentNote = () => {
    setFileProbe('Copy: requesting FILE:READ and FILE:WRITE…');
    void Promise.all([
      PluginManager.requestPermission('plugin.permission.FILE:READ', 'Read the saved current note for F0.'),
      PluginManager.requestPermission('plugin.permission.FILE:WRITE', 'Write one atomic F0 copy into Note.'),
    ])
      .then(async grants => {
        if (!grants.every(Boolean)) throw new Error('FILE permission was denied');
        const path = await currentNotePath();
        const result = JSON.parse(await nativeClient.f0CopyCurrentNote(path));
        const opened = await PluginFileAPI.openFile(result.destinationPath, -1);
        if (!opened?.success) throw new Error('Supernote could not open the F0 copy');
        return { filename: result.filename, bytes: result.bytes, opened: true };
      })
      .then(result => setFileProbe(`Copy: ${JSON.stringify(result)}`))
      .catch(error => setFileProbe(`Copy: FAIL ${message(error)}`));
  };

  const saveAndOpenInboxNote = () => {
    setFileProbe('Receive: requesting FILE:WRITE…');
    void PluginManager.requestPermission('plugin.permission.FILE:WRITE',
      'Decrypt one staging inbox note into Note and open it in Supernote.')
      .then(async granted => {
        if (!granted) throw new Error('FILE:WRITE was denied');
        const active = await currentSession();
        const polled = inbox.length > 0 ? { records: inbox } : await relayPost('/v1/companion/poll',
          { deviceId: active.deviceId }, active.sessionToken);
        const records = Array.isArray(polled.records) ? polled.records : [];
        for (const record of records) {
          try {
            const result = JSON.parse(await nativeClient.e2DecryptRecordToNote(JSON.stringify(record)));
            // openFile stops this PluginHost JS runtime. ACK the complete, fsynced
            // output first; a subsequent open failure leaves a usable Note file.
            await relayPost('/v1/companion/ack', { deviceId: active.deviceId, recordIds: [result.recordId] },
              active.sessionToken);
            const opened = await PluginFileAPI.openFile(result.destinationPath, -1);
            if (!opened?.success) throw new Error('Supernote could not open saved note');
            setInbox(previous => previous.filter(item => item.id !== result.recordId));
            return { filename: result.filename, bytes: result.noteBytes, sha256: result.sha256, opened: true };
          } catch (error) {
            // An unauthenticated/tampered record is retained by the relay; try a later record.
          }
        }
        throw new Error('no decryptable inbox note');
      })
      .then(result => setFileProbe(`Receive: ${JSON.stringify(result)}`))
      .catch(error => setFileProbe(`Receive: FAIL ${message(error)}`));
  };

  const requestInternet = () => {
    void PluginManager.requestPermission(INTERNET,
      'The disposable file-exchange experiment needs network access to its staging relay.')
      .then(value => setRelay(`INTERNET consent returned ${value}.`))
      .catch(error => setRelay(`INTERNET consent failed: ${message(error)}`));
  };

  // F2 transport probe: this is deliberately React Native fetch, not the old
  // NPK RelayClient. It requires a WebPKI-valid Tailscale certificate; React
  // Native fetch has no supported leaf-pinning hook for the self-signed relay.
  const probeReactRelay = () => {
    setRelay('React relay probe: requesting INTERNET…');
    void PluginManager.requestPermission(INTERNET,
      'Probe React Native HTTPS to the disposable staging relay.')
      .then(async granted => {
        if (!granted) throw new Error('INTERNET was denied');
        const base = await nativeClient.e2RelayBase();
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 10_000);
        try {
          const response = await fetch(`${base}/healthz`, {
            method: 'GET', redirect: 'error', signal: abort.signal,
          });
          const body = await response.text();
          if (!response.ok || body.length > 64 || body !== 'ok') throw new Error('unexpected relay health response');
          return 'React relay probe: HTTPS health check passed.';
        } finally {
          clearTimeout(timeout);
        }
      })
      .then(setRelay)
      .catch(error => setRelay(`React relay probe: FAIL ${message(error)}`));
  };

  useEffect(() => {
    if (!nativeClient?.describe) return setStatus('FAIL: native NPK is unavailable.');
    void nativeClient.describe()
      .then(result => setStatus(`OK: NPK revision ${result.nativeRevision}; no in-plugin renderer loaded.`))
      .catch(error => setStatus(`FAIL: ${message(error)}`));
  }, []);

  return <ScrollView contentContainerStyle={styles.root}>
    <Text style={styles.eyebrow}>DISPOSABLE · FILE EXCHANGE</Text>
    <Text style={styles.title}>Encrypted whole-note delivery</Text>
    <Text style={styles.copy}>
      This plugin does not render, convert, animate, or inspect notes. Received notes will be
      atomically saved and opened by Supernote Notes in a later file-contract phase.
    </Text>

    <Text style={styles.section}>Staging relay</Text>
    <Button label="Request INTERNET consent" onPress={requestInternet} />
    <Button label="Probe React HTTPS relay" onPress={probeReactRelay} />
    <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="1234-5678"
      keyboardType="numeric" autoCorrect={false} autoCapitalize="none" />
    <View style={styles.controls}>
      <Button label="Claim pairing code" onPress={claimPairingCode} />
      <Button label="Refresh inbox" onPress={refreshInbox} />
    </View>
    <TextInput style={styles.input} value={recipient} onChangeText={setRecipient} placeholder="recipient"
      autoCorrect={false} autoCapitalize="none" />
    <View style={styles.controls}>
      <Button label="Refresh encrypted inbox" onPress={refreshInbox} />
      <Button label="Logout" onPress={logout} />
    </View>
    <Text selectable style={styles.result}>{relay}</Text>

    <Text style={styles.section}>F0 file contract</Text>
    <Text style={styles.copy}>
      Save the active note, inspect its bounded native digest, then create one atomic Note-folder copy
      and open it in Supernote Notes. Paths remain transient and are never displayed.
    </Text>
    <View style={styles.controls}>
      <Button label="Inspect saved current note" onPress={inspectCurrentNote} />
      <Button label="Copy and open in Notes" onPress={copyAndOpenCurrentNote} />
      <Button label="Encrypt and send current note" onPress={sendCurrentNote} />
      <Button label="Save and open one inbox note" onPress={saveAndOpenInboxNote} />
    </View>
    <Text selectable style={styles.result}>{fileProbe}</Text>
    <Text selectable style={styles.status}>{status}</Text>
    <Button label="Close experiment" onPress={() => PluginManager.closePluginView()} />
  </ScrollView>;
}

function Button({ label, onPress }) {
  return <Pressable style={styles.button} onPress={onPress}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, padding: 22, backgroundColor: '#f7f4ed' },
  eyebrow: { color: '#5f5a51', fontSize: 13, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: '#000', fontSize: 25, fontWeight: '700', marginTop: 6 },
  copy: { color: '#28251f', fontSize: 16, lineHeight: 23, marginTop: 12 },
  section: { color: '#000', fontSize: 18, fontWeight: '700', marginTop: 24 },
  controls: { flexDirection: 'row', flexWrap: 'wrap' },
  button: { alignSelf: 'flex-start', borderColor: '#000', borderWidth: 1, marginRight: 10, marginTop: 10, paddingHorizontal: 14, paddingVertical: 10 },
  buttonText: { color: '#000', fontSize: 14 },
  input: { borderColor: '#000', borderWidth: 1, marginTop: 10, paddingHorizontal: 12, paddingVertical: 8, color: '#000', fontSize: 15 },
  result: { color: '#28251f', fontSize: 12, lineHeight: 18, marginTop: 12 },
  status: { color: '#28251f', fontSize: 13, lineHeight: 20, marginTop: 16 },
});
