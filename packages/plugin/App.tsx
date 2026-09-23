import React, { useEffect, useRef, useState } from 'react';
import { NativeModules, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI } from 'sn-plugin-lib';

const nativeClient = NativeModules.OlaInkNativeClient;
const INTERNET = 'plugin.permission.INTERNET';

/** Journal rows persisted by the NPK encrypted UI journal. */
interface JournalEntry {
  id: string;
  sender?: string;
  recipient?: string;
  filename?: string;
  bytes?: number;
  at?: number;
}

/** Foreground React transport session for the native-persisted device. */
interface SessionState {
  deviceId: string;
  userId: string;
  username: string;
  sessionToken: string;
}

/** Opaque relay inbox record; handed to NPK as a JSON string. */
type RelayRecord = Record<string, unknown>;

/** sn-plugin-lib host calls return an untyped Object; this is the observed shape. */
interface HostResponse {
  success: boolean;
  result?: string;
}

// Journal entries are appended oldest first; lists show newest first
// (entries without a timestamp sort last, also newest first).
const newestFirst = <T extends { at?: number }>(entries: T[]): T[] =>
  entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.at || 0) - (a.entry.at || 0) || b.index - a.index)
    .map(({ entry }) => entry);

// sn-plugin-lib's PluginLifeType.start: the plugin view became visible.
const PLUGIN_LIFE_START = 2;
const message = (error: unknown) => (error as Error)?.message || String(error);

export default function App() {
  const [status, setStatus] = useState('Loading Ola Ink…');
  const [relay, setRelay] = useState('Pair this Supernote at app.olaink.com to begin.');
  const [code, setCode] = useState('');
  const [recipient, setRecipient] = useState('');
  const [activeNoteName, setActiveNoteName] = useState('No open note detected.');
  const [fileProbe, setFileProbe] = useState('F0 file-contract results appear here.');
  const [inbox, setInbox] = useState<RelayRecord[]>([]);
  const [journalInbox, setJournalInbox] = useState<JournalEntry[]>([]);
  const [sent, setSent] = useState<JournalEntry[]>([]);
  const [muted, setMuted] = useState<string[]>([]);
  const [muteName, setMuteName] = useState('');
  const [recentOpen, setRecentOpen] = useState(false);
  const [tab, setTab] = useState('inbox');
  const [sendConfirm, setSendConfirm] = useState(false);
  // The device session is native-persisted but enters JS only for this foreground
  // React transport session. It is never rendered or placed in AsyncStorage.
  const session = useRef<SessionState | null>(null);
  // Read by the plugin-life listener, which is registered once.
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const recentUsers = Object.values([...journalInbox.map(item => ({ name: item.sender, at: item.at || 0 })),
    ...sent.map(item => ({ name: item.recipient, at: item.at || 0 }))]
    .reduce((users, item) => {
      const name = typeof item.name === 'string' ? item.name.trim().toLowerCase() : '';
      if (name && (!users[name] || users[name].at < item.at)) users[name] = { name, at: item.at };
      return users;
    }, {} as Record<string, { name: string; at: number }>)).sort((a, b) => b.at - a.at).slice(0, 10);

  const relayPost = async (path: string, body: unknown, sessionToken: string | null = null) => {
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

  const loadJournal = () => void nativeClient.e2Journal()
    .then((raw: string) => {
      const journal = JSON.parse(raw);
      setJournalInbox(newestFirst(Array.isArray(journal.inbox) ? journal.inbox : []));
      setSent(newestFirst(Array.isArray(journal.sent) ? journal.sent : []));
      setMuted(Array.isArray(journal.muted) ? journal.muted : []);
    })
    .catch(() => {});

  const setMutedUser = (mutedValue: boolean, explicitName = muteName) => {
    void nativeClient.e2SetMuted(explicitName.trim(), mutedValue)
      .then((raw: string) => {
        const journal = JSON.parse(raw);
        setMuted(Array.isArray(journal.muted) ? journal.muted : []);
        setMuteName('');
      })
      .catch((error: unknown) => setRelay(`Mute: FAIL ${message(error)}`));
  };

  const refreshInbox = (silent = false) => {
    if (!silent) setRelay('Inbox: refreshing…');
    void currentSession()
      .then(async active => relayPost('/v1/companion/poll', { deviceId: active.deviceId }, active.sessionToken))
      .then(result => {
        const records = Array.isArray(result.records) ? result.records : [];
        setInbox(records);
        if (!silent) setRelay(`Inbox: ${records.length} encrypted record(s) waiting.`);
      })
      .catch(error => { if (!silent) setRelay(`Inbox: FAIL ${message(error)}`); });
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

  const refreshActiveNote = () => {
    void PluginCommAPI.getCurrentFilePath()
      .then(current => {
        const host = current as HostResponse | null;
        const path = host?.success && typeof host.result === 'string' ? host.result : '';
        setActiveNoteName(path.endsWith('.note') ? (path.split('/').pop() ?? '') : 'No open note detected.');
      })
      .catch(() => setActiveNoteName('No open note detected.'));
  };

  const openSendTab = () => {
    setTab('send');
    refreshActiveNote();
  };

  const currentNotePath = async () => {
    const saved = (await PluginNoteAPI.saveCurrentNote()) as HostResponse | null;
    if (!saved?.success) throw new Error('Supernote did not save the current note');
    const current = (await PluginCommAPI.getCurrentFilePath()) as HostResponse | null;
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
        // The label always names the note actually being encrypted.
        setActiveNoteName(path.split('/').pop() ?? '');
        const active = await currentSession();
        const directoryResult = await relayPost('/v1/companion/directory', {
          deviceId: active.deviceId, username: recipient.trim(),
        }, active.sessionToken);
        const encrypted = JSON.parse(await nativeClient.e2CreateFileRecord(path,
          JSON.stringify(directoryResult.directory)));
        await relayPost('/v1/companion/notes', {
          deviceId: active.deviceId, username: recipient.trim(), record: JSON.parse(encrypted.record),
        }, active.sessionToken);
        await nativeClient.e2RecordSent(recipient.trim(), encrypted.recordId, encrypted.filename, encrypted.noteBytes);
        return { sent: true, recordId: encrypted.recordId, bytes: encrypted.noteBytes,
          sha256: encrypted.noteSha256, slots: encrypted.slots };
      })
      .then(result => { loadJournal(); setFileProbe(`Send: ${JSON.stringify(result)}`); })
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
        const opened = (await PluginFileAPI.openFile(result.destinationPath, -1)) as HostResponse | null;
        if (!opened?.success) throw new Error('Supernote could not open the F0 copy');
        return { filename: result.filename, bytes: result.bytes, opened: true };
      })
      .then(result => setFileProbe(`Copy: ${JSON.stringify(result)}`))
      .catch(error => setFileProbe(`Copy: FAIL ${message(error)}`));
  };

  const saveAndOpenInboxNote = (selectedRecord: RelayRecord | null) => {
    setFileProbe('Receive: requesting FILE:WRITE…');
    void PluginManager.requestPermission('plugin.permission.FILE:WRITE',
      'Decrypt one staging inbox note into Note and open it in Supernote.')
      .then(async granted => {
        if (!granted) throw new Error('FILE:WRITE was denied');
        const active = await currentSession();
        const polled = selectedRecord ? { records: [selectedRecord] }
          : inbox.length > 0 ? { records: inbox } : await relayPost('/v1/companion/poll',
          { deviceId: active.deviceId }, active.sessionToken);
        const records = Array.isArray(polled.records) ? polled.records : [];
        for (const record of records) {
          try {
            const result = JSON.parse(await nativeClient.e2DecryptRecordToNote(JSON.stringify(record)));
            // openFile stops this PluginHost JS runtime. ACK the complete, fsynced
            // output first; a subsequent open failure leaves a usable Note file.
            await relayPost('/v1/companion/ack', { deviceId: active.deviceId, recordIds: [result.recordId] },
              active.sessionToken);
            const opened = (await PluginFileAPI.openFile(result.destinationPath, -1)) as HostResponse | null;
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

  const reopenStoredInboxNote = (recordId: string) => {
    setRelay('Inbox: opening saved note…');
    void PluginManager.requestPermission('plugin.permission.FILE:WRITE',
      'Write this encrypted Inbox note into the OlaInk Note folder and open it.')
      .then(async granted => {
        if (!granted) throw new Error('FILE:WRITE was denied');
        const result = JSON.parse(await nativeClient.e2DecryptStoredRecordToNote(recordId));
        const opened = (await PluginFileAPI.openFile(result.destinationPath, -1)) as HostResponse | null;
        if (!opened?.success) throw new Error('Supernote could not open saved note');
      })
      .catch(error => setRelay(`Inbox: FAIL ${message(error)}`));
  };

  const requestInternet = () => {
    void PluginManager.requestPermission(INTERNET,
      'Ola Ink needs network access to app.olaink.com for pairing and note delivery.')
      .then(value => setRelay(`INTERNET consent returned ${value}.`))
      .catch(error => setRelay(`INTERNET consent failed: ${message(error)}`));
  };

  // F2 transport probe: this is deliberately React Native fetch, not the old
  // NPK RelayClient. It requires a WebPKI-valid Tailscale certificate; React
  // Native fetch has no supported leaf-pinning hook for the self-signed relay.
  const probeReactRelay = () => {
    setRelay('React relay probe: requesting INTERNET…');
    void PluginManager.requestPermission(INTERNET,
      'Check the secure Ola Ink relay connection.')
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
      .then(() => { setStatus('Ready.'); loadJournal(); })
      .catch((error: unknown) => setStatus(`FAIL: ${message(error)}`));
    // Foreground-only inbox refresh: polling ends when PluginHost closes this view.
    refreshInbox(true);
    const interval = setInterval(() => refreshInbox(true), 10_000);
    // The React tree can outlive a close/reopen of the plugin view, so the
    // Send tab must re-read the open note whenever the view starts again
    // (the user may have switched notes in between).
    const life = PluginManager.registerPluginLifeListener({
      onMsg: (data: { state?: number } | null) => {
        console.log(`[olaink] plugin life state=${String(data?.state)} tab=${tabRef.current}`);
        if (data?.state === PLUGIN_LIFE_START && tabRef.current === 'send') refreshActiveNote();
      },
    });
    return () => { clearInterval(interval); life.remove(); };
  }, []);

  return <ScrollView contentContainerStyle={styles.root}>
    <Text style={styles.eyebrow}>OLA INK</Text>
    <View style={styles.tabs}>
      <Tab label="Inbox" active={tab === 'inbox'} onPress={() => setTab('inbox')} />
      <Tab label="Send" active={tab === 'send'} onPress={openSendTab} />
      <Tab label="Settings" active={tab === 'settings'} onPress={() => setTab('settings')} />
      <Pressable style={styles.closeTab} onPress={() => PluginManager.closePluginView()}><Text style={styles.closeTabText}>Close Ola Ink</Text></Pressable>
    </View>

    {tab === 'inbox' && <View>
      <Text style={styles.section}>Inbox</Text>
      <Button label="Sync inbox" onPress={refreshInbox} />
      {[...inbox].reverse().map((item, index) => <Pressable key={`${index}-${String(item.id)}`} style={styles.noteRow} onPress={() => saveAndOpenInboxNote(item)}>
        <Text style={styles.noteTitle}>Encrypted note {index + 1}</Text><Text style={styles.noteMeta}>Tap to save and open in Supernote Notes</Text>
      </Pressable>)}
      {journalInbox.filter(item => !muted.includes(String(item.sender || '').toLowerCase())).map(item => <Pressable key={item.id} style={styles.noteRow} onPress={() => reopenStoredInboxNote(item.id)}>
        <Text style={styles.noteTitle}>{item.filename}</Text><Text style={styles.noteMeta}>{item.sender} · {item.bytes} bytes · Tap to open</Text>
      </Pressable>)}
      {inbox.length === 0 && journalInbox.length === 0 && <Text style={styles.empty}>No notes waiting. Share your Ola Ink address to receive a note.</Text>}
      <Text selectable style={styles.result}>{relay}</Text>
    </View>}

    {tab === 'send' && <View>
      <Text style={styles.section}>Send a note</Text>
      <Text style={styles.copy}>Currently open note: {activeNoteName}</Text>
      <TextInput style={styles.input} value={recipient} onChangeText={setRecipient} placeholder="Recipient Ola Ink address"
        autoCorrect={false} autoCapitalize="none" />
      {recentUsers.length > 0 && <View style={styles.recent}><Pressable style={styles.recentToggle} onPress={() => setRecentOpen(value => !value)}>
        <Text style={styles.buttonText}>Recent users ({recentUsers.length}) ▾</Text></Pressable>
        {recentOpen && <View style={styles.recentList}>{recentUsers.map(user => <Pressable key={user.name} style={styles.recentItem}
          onPress={() => { setRecipient(user.name); setRecentOpen(false); }}><Text style={styles.noteTitle}>{user.name}</Text></Pressable>)}</View>}
      </View>}
      {!sendConfirm
        ? <Button label="Continue" onPress={() => setSendConfirm(true)} />
        : <View style={styles.confirm}><Text style={styles.copy}>Send the current saved note to {recipient || 'this recipient'}?</Text>
          <Button label="Yes, encrypt and send" onPress={() => { setSendConfirm(false); sendCurrentNote(); }} />
          <Button label="No" onPress={() => setSendConfirm(false)} /></View>}
      {sent.map(item => <View key={item.id} style={styles.noteRow}>
        <Text style={styles.noteTitle}>{item.filename}</Text><Text style={styles.noteMeta}>Sent to {item.recipient}</Text>
      </View>)}
      <Text selectable style={styles.result}>{fileProbe}</Text>
    </View>}

    {tab === 'settings' && <View>
      <Text style={styles.section}>Pair this Supernote</Text>
      <Text style={styles.copy}>Visit app.olaink.com, sign in, select Add Supernote companion, then enter the eight-digit pairing code below.</Text>
      <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="1234-5678"
        keyboardType="numeric" autoCorrect={false} autoCapitalize="none" />
      <Button label="Pair Supernote" onPress={claimPairingCode} />
      <Text style={styles.section}>Muted users</Text>
      <Text style={styles.copy}>Muted users stay encrypted on this Supernote but are hidden from Inbox.</Text>
      <TextInput style={styles.input} value={muteName} onChangeText={setMuteName} placeholder="Ola Ink address"
        autoCorrect={false} autoCapitalize="none" />
      <Button label="Mute user" onPress={() => setMutedUser(true)} />
      {muted.map(name => <View key={name} style={styles.noteRow}><Text style={styles.noteTitle}>{name}</Text>
        <Button label="Unmute" onPress={() => setMutedUser(false, name)} /></View>)}
      <Button label="Log out this Supernote" onPress={logout} />
      <Text selectable style={styles.result}>{relay}</Text>
    </View>}

    <Text selectable style={styles.status}>{status}</Text>
  </ScrollView>;
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable style={styles.button} onPress={onPress}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

function Tab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return <Pressable style={[styles.tab, active && styles.tabActive]} onPress={onPress}>
    <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, padding: 44, backgroundColor: '#f7f4ed' },
  eyebrow: { color: '#5f5a51', fontSize: 26, fontWeight: '700', letterSpacing: 3 },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 44, borderBottomColor: '#000', borderBottomWidth: 2 },
  tab: { borderWidth: 2, borderBottomWidth: 0, borderColor: '#000', marginRight: 16, paddingHorizontal: 28, paddingVertical: 20 },
  tabActive: { backgroundColor: '#000' },
  tabText: { color: '#000', fontSize: 30, fontWeight: '700' },
  tabTextActive: { color: '#f7f4ed' },
  closeTab: { alignSelf: 'center', marginLeft: 'auto', borderColor: '#000', borderWidth: 2, paddingHorizontal: 20, paddingVertical: 16 },
  closeTabText: { color: '#000', fontSize: 26, fontWeight: '700' },
  copy: { color: '#28251f', fontSize: 32, lineHeight: 46, marginTop: 24 },
  section: { color: '#000', fontSize: 36, fontWeight: '700', marginTop: 48 },
  controls: { flexDirection: 'row', flexWrap: 'wrap' },
  confirm: { borderLeftWidth: 6, borderLeftColor: '#000', marginTop: 28, paddingLeft: 24 },
  empty: { color: '#5f5a51', fontSize: 30, lineHeight: 44, marginTop: 36 },
  noteRow: { borderLeftWidth: 6, borderLeftColor: '#233329', marginTop: 28, paddingLeft: 24 },
  noteTitle: { color: '#000', fontSize: 32, fontWeight: '700' },
  noteMeta: { color: '#5f5a51', fontSize: 28, marginTop: 6 },
  recent: { marginTop: 20 },
  recentToggle: { alignSelf: 'flex-start', borderColor: '#000', borderWidth: 2, paddingHorizontal: 24, paddingVertical: 18 },
  recentList: { borderColor: '#000', borderWidth: 2, marginTop: 8 },
  recentItem: { borderBottomColor: '#d6d0c5', borderBottomWidth: 2, paddingHorizontal: 24, paddingVertical: 20 },
  button: { alignSelf: 'flex-start', borderColor: '#000', borderWidth: 2, marginRight: 20, marginTop: 20, paddingHorizontal: 28, paddingVertical: 20 },
  buttonText: { color: '#000', fontSize: 28 },
  input: { borderColor: '#000', borderWidth: 2, marginTop: 20, paddingHorizontal: 24, paddingVertical: 16, color: '#000', fontSize: 30 },
  result: { color: '#28251f', fontSize: 24, lineHeight: 36, marginTop: 24 },
  status: { color: '#28251f', fontSize: 26, lineHeight: 40, marginTop: 32 },
});
