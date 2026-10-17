import React, { useEffect, useRef, useState } from 'react';
import { AppQrCode, APP_URL } from './src/appQrCode';
import { Image, NativeModules, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
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
/** Pairing errors in plain language; relay/NPK details stay for anything unexpected. */
const pairingFailure = (reason: string) => {
  if (reason.includes('HTTP 400')) return 'That code did not work. Codes work once and expire after 10 minutes; get a new one on the site and try again.';
  if (reason.includes('HTTP 429')) return 'Too many attempts. Wait a minute, then try again.';
  if (reason.includes('eight digits')) return 'Enter all eight digits of the pairing code.';
  if (reason.includes('INTERNET was denied')) return 'Ola Ink needs network access to pair. Allow it when asked, then try again.';
  return `Pairing failed: ${reason}`;
};
const message = (error: unknown) => (error as Error)?.message || String(error);


/** Ceiling for ordinary relay responses (pairing, directory, send, ack). */
const RELAY_MAX_RESPONSE = 1024 * 1024;
/** Ceiling for a whole inbox poll: room for two maximum-size relay records
 * (8 MiB each) without risking the JS heap on the device. */
const RELAY_POLL_MAX_RESPONSE = 24 * 1024 * 1024;

export default function App() {
  const [status, setStatus] = useState('Loading Ola Ink…');
  const [relay, setRelay] = useState('');
  // null until the NPK reports whether this Supernote holds a device session.
  const [paired, setPaired] = useState<boolean | null>(null);
  const [pairedUsername, setPairedUsername] = useState('');
  const [code, setCode] = useState('');
  const [recipient, setRecipient] = useState('');
  const [activeNoteName, setActiveNoteName] = useState('No open note detected.');
  const [fileProbe, setFileProbe] = useState('');
  const [inbox, setInbox] = useState<RelayRecord[]>([]);
  const [journalInbox, setJournalInbox] = useState<JournalEntry[]>([]);
  const [sent, setSent] = useState<JournalEntry[]>([]);
  const [muted, setMuted] = useState<string[]>([]);
  const [muteName, setMuteName] = useState('');
  const [recentOpen, setRecentOpen] = useState(false);
  const [tab, setTab] = useState('inbox');
  const [sendConfirm, setSendConfirm] = useState(false);
  // Public half of the on-device key (device ID + SPKI), for the Settings review.
  const [deviceIdentity, setDeviceIdentity] = useState<{ deviceId: string; publicKeySpki: string } | null>(null);
  const [deviceConfirm, setDeviceConfirm] = useState(false);
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
    // A poll returns every waiting record at once, and one record can carry a
    // note up to the NPK's 5 MiB limit (about 9 MiB once encrypted and
    // encoded). Under the old 1 MiB cap a single note over ~560 KB made every
    // sync fail and blocked the whole inbox. Other endpoints stay small.
    const isPoll = path === '/v1/companion/poll';
    const maxResponseChars = isPoll ? RELAY_POLL_MAX_RESPONSE : RELAY_MAX_RESPONSE;
    const base = await nativeClient.e2RelayBase();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), isPoll ? 60_000 : 10_000);
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
      if (text.length > maxResponseChars) throw new Error('relay response exceeded size cap');
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
        setPaired(true);
        setPairedUsername(pairing.username || '');
        setCode('');
        setTab('inbox');
        loadDeviceIdentity();
        loadJournal();
        refreshInbox(true);
        return '';
      })
      .then(setRelay)
      .catch(error => setRelay(pairingFailure(message(error))));
  };

  const checkPaired = () => void nativeClient.e2Status()
    .then((raw: string) => {
      const status = JSON.parse(raw);
      setPaired(status.paired === true);
      setPairedUsername(typeof status.username === 'string' ? status.username : '');
    })
    .catch(() => setPaired(false));

  // Only public material (device ID + SPKI); the private key and session token
  // stay inside the NPK. Absent identity (fresh/unpaired) resolves to null.
  const loadDeviceIdentity = () => void nativeClient.e2IdentityInfo()
    .then((raw: string) => {
      const info = JSON.parse(raw);
      setDeviceIdentity(info.identityReady && typeof info.deviceId === 'string' && typeof info.publicKeySpki === 'string'
        ? { deviceId: info.deviceId, publicKeySpki: info.publicKeySpki }
        : null);
    })
    .catch(() => setDeviceIdentity(null));

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

  /**
   * Removes the device: the relay session is ended (best effort, reported),
   * then the local key, saved inbox, and journal are deleted. Local removal
   * proceeds even when the relay is unreachable; the stale relay session then
   * only routes notes to a key that no longer exists on this Supernote.
   */
  const removeDevice = () => {
    setDeviceConfirm(false);
    setRelay('Remove: ending relay session…');
    void (async () => {
      let relayOutcome = '';
      try {
        const active = await currentSession();
        await relayPost('/v1/companion/logout', { deviceId: active.deviceId }, active.sessionToken);
      } catch {
        relayOutcome = ' The relay could not be reached, so its session was not ended; run Remove again while online.';
      }
      await nativeClient.e2ClearLocal();
      session.current = null;
      setInbox([]);
      setPaired(false);
      setPairedUsername('');
      setDeviceIdentity(null);
      return `Device key removed.${relayOutcome}`;
    })()
      .then(setRelay)
      .catch(error => setRelay(`Remove: FAIL ${message(error)}`));
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
            // The NPK journaled it; show it among saved notes right away.
            loadJournal();
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
        loadJournal();
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
      .then(() => { setStatus('Ready.'); checkPaired(); loadDeviceIdentity(); loadJournal(); })
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
        if (data?.state !== PLUGIN_LIFE_START) return;
        // Lists may be stale after the view was hidden (e.g. a note opened).
        checkPaired();
        loadDeviceIdentity();
        loadJournal();
        refreshInbox(true);
        if (tabRef.current === 'send') refreshActiveNote();
      },
    });
    return () => { clearInterval(interval); life.remove(); };
  }, []);

  const close = () => PluginManager.closePluginView();
  const visibleInbox = journalInbox.filter(item => !muted.includes(String(item.sender || '').toLowerCase()));
  const paneTitle = paired === false ? 'Set up Ola Ink'
    : tab === 'inbox' ? `Inbox (${inbox.length + visibleInbox.length})`
      : tab === 'send' ? 'Send a note' : 'Settings';
  const sideTabs = paired === true
    ? [
      { key: 'inbox', label: 'Inbox', icon: ICONS.inbox, onPress: () => setTab('inbox') },
      { key: 'send', label: 'Send', icon: ICONS.send, onPress: openSendTab },
      { key: 'settings', label: 'Settings', icon: ICONS.settings, onPress: () => setTab('settings') },
    ]
    : [{ key: 'pair', label: 'Pair', icon: ICONS.pair, onPress: () => undefined }];
  const activeKey = paired === true ? tab : 'pair';

  // Mirrors the Supernote system Settings screen: a black title bar with the
  // close button on the left, a vertical tab list, and a content pane.
  return <View style={styles.screen}>
    <View style={styles.header}>
      <Pressable style={styles.headerLeft} onPress={close} accessibilityLabel="Close Ola Ink">
        <Image source={ICONS.close} style={styles.headerIcon} />
        <Text style={styles.headerTitle}>Ola Ink</Text>
      </Pressable>
      <Text style={styles.headerCenter} numberOfLines={1}>{paneTitle}</Text>
    </View>

    <View style={styles.body}>
      <View style={styles.sidebar}>
        {sideTabs.map(item => <SideTab key={item.key} label={item.label} icon={item.icon}
          active={item.key === activeKey} onPress={item.onPress} />)}
      </View>

      <ScrollView style={styles.pane} contentContainerStyle={styles.paneContent} keyboardShouldPersistTaps="handled">
        {paired === false && <View>
          {/* The code field sits near the top: the on-screen keyboard covers the
              lower part of the screen while typing. */}
          <Text style={styles.copy}>Enter the eight-digit pairing code from app.olaink.com to pair this Supernote.</Text>
          <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="1234-5678"
            placeholderTextColor="#9a9a9a" keyboardType="numeric" autoCorrect={false} autoCapitalize="none" />
          <PrimaryButton label="Pair this Supernote" onPress={claimPairingCode} />
          {relay ? <Text selectable style={styles.result}>{relay}</Text> : null}

          <Text style={styles.section}>Need a pairing code?</Text>
          <Text style={styles.step}>1. On your phone or computer, open Ola Ink</Text>
          <View style={styles.qrRow}>
            <AppQrCode moduleSize={8} />
            <View style={styles.qrCaption}>
              <Text style={styles.copy}>Scan this code with your phone's camera, or type the address:</Text>
              <Text style={styles.url}>{APP_URL.replace('https://', '')}</Text>
            </View>
          </View>
          <Text style={styles.step}>2. Sign in, or create an account</Text>
          <Text style={styles.copy}>Use Sign in with passkey if you already have an account.</Text>
          <Text style={styles.step}>3. Choose Add Supernote companion</Text>
          <Text style={styles.copy}>The site shows an eight-digit code. It works once and expires after 10 minutes. Enter it at the top of this screen.</Text>
        </View>}

        {paired === true && tab === 'inbox' && <View>
          <ListRow title="Sync inbox" onPress={refreshInbox} solid />
          {[...inbox].reverse().map((item, index) => <ListRow key={`${index}-${String(item.id)}`}
            title={`Encrypted note ${index + 1}`} meta="New · tap to save and open in Notes" onPress={() => saveAndOpenInboxNote(item)} />)}
          {visibleInbox.map(item => <ListRow key={item.id} title={String(item.filename)}
            meta={`${item.sender} · ${formatBytes(Number(item.bytes))}`} onPress={() => reopenStoredInboxNote(item.id)} />)}
          {inbox.length === 0 && visibleInbox.length === 0 && <Text style={styles.empty}>No notes waiting. Share your Ola Ink address to receive a note.</Text>}
          {relay ? <Text selectable style={styles.result}>{relay}</Text> : null}
        </View>}

        {paired === true && tab === 'send' && <View>
          <Text style={styles.label}>Current note</Text>
          <Text style={styles.value}>{activeNoteName || 'No note open'}</Text>
          <Text style={styles.label}>Send to</Text>
          <TextInput style={styles.input} value={recipient} onChangeText={setRecipient} placeholder="Ola Ink address"
            placeholderTextColor="#9a9a9a" autoCorrect={false} autoCapitalize="none" />
          {recentUsers.length > 0 && <View>
            <ListRow title={`Recent (${recentUsers.length})`} onPress={() => setRecentOpen(value => !value)} solid />
            {recentOpen && recentUsers.map(user => <ListRow key={user.name} title={user.name}
              onPress={() => { setRecipient(user.name); setRecentOpen(false); }} />)}
          </View>}
          {!sendConfirm
            ? <PrimaryButton label="Continue" onPress={() => setSendConfirm(true)} />
            : <View style={styles.confirm}>
              <Text style={styles.copy}>Send the current saved note to {recipient || 'this recipient'}?</Text>
              <View style={styles.buttonRow}>
                <PrimaryButton label="Encrypt and send" onPress={() => { setSendConfirm(false); sendCurrentNote(); }} />
                <SecondaryButton label="Cancel" onPress={() => setSendConfirm(false)} />
              </View>
            </View>}
          {fileProbe ? <Text selectable style={styles.result}>{fileProbe}</Text> : null}
          {sent.length > 0 && <Text style={styles.section}>Sent ({sent.length})</Text>}
          {sent.map(item => <ListRow key={item.id} title={String(item.filename)} meta={`To ${item.recipient}`} />)}
        </View>}

        {paired === true && tab === 'settings' && <View>
          <Text style={styles.section}>This Supernote</Text>
          <Text style={styles.copy}>{pairedUsername ? `Paired with ${pairedUsername}.` : 'Paired with your Ola Ink account.'}</Text>
          <Text style={styles.section}>Device key</Text>
          {deviceIdentity ? <View>
            <Text style={styles.label}>Device ID</Text>
            <Text selectable style={styles.keyValue}>{deviceIdentity.deviceId}</Text>
            <Text style={styles.label}>Public key</Text>
            <Text selectable style={styles.keyValue}>{deviceIdentity.publicKeySpki}</Text>
            <Text style={styles.copy}>The key is created on this Supernote. Only the public half is shared with the relay; the private key never leaves the device and cannot be exported from it.</Text>
          </View> : <Text style={styles.empty}>Device key is not available right now.</Text>}
          {!deviceConfirm
            ? <ListRow title="Remove this device" meta="Deletes the key and saved inbox; ends the relay session" onPress={() => setDeviceConfirm(true)} />
            : <View style={styles.confirm}>
              <Text style={styles.copy}>Remove this device? The key and saved inbox are deleted from this Supernote and the relay session ends. Pairing again creates a new key and needs a new code.</Text>
              <View style={styles.buttonRow}>
                <PrimaryButton label="Remove" onPress={removeDevice} />
                <SecondaryButton label="Cancel" onPress={() => setDeviceConfirm(false)} />
              </View>
            </View>}
          <Text style={styles.section}>Muted users ({muted.length})</Text>
          <Text style={styles.copy}>Notes from muted users stay encrypted on this Supernote but are hidden from Inbox.</Text>
          <TextInput style={styles.input} value={muteName} onChangeText={setMuteName} placeholder="Ola Ink address"
            placeholderTextColor="#9a9a9a" autoCorrect={false} autoCapitalize="none" />
          <SecondaryButton label="Mute user" onPress={() => setMutedUser(true)} />
          {muted.map(name => <ListRow key={name} title={name} action="Unmute" onPress={() => setMutedUser(false, name)} />)}
          {relay ? <Text selectable style={styles.result}>{relay}</Text> : null}
        </View>}

        <Text selectable style={styles.status}>{status}</Text>
      </ScrollView>
    </View>
  </View>;
}

const ICONS = {
  close: require('./assets/ui/close.png'),
  chevron: require('./assets/ui/chevron.png'),
  inbox: require('./assets/ui/inbox.png'),
  send: require('./assets/ui/send.png'),
  settings: require('./assets/ui/settings.png'),
  pair: require('./assets/ui/pair.png'),
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A dashed rule, drawn with Views (Android ignores dashed borders on one side). */
function Dashes() {
  return <View style={styles.dashes}>{Array.from({ length: 200 }, (_, i) => <View key={i} style={styles.dash} />)}</View>;
}

function SideTab({ label, icon, active, onPress }: { label: string; icon: number; active: boolean; onPress: () => void }) {
  return <Pressable onPress={() => onPress()} accessibilityRole="tab" accessibilityState={{ selected: active }}>
    <View style={styles.sideTab}>
      <Image source={icon} style={styles.sideIcon} />
      <Text style={styles.sideLabel}>{label}</Text>
      {active && <View style={styles.sideSelected} />}
    </View>
    <Dashes />
  </Pressable>;
}

/** A Settings-style row: title, optional detail, chevron or action, separator.
 * onPress is called with no arguments (handlers like refreshInbox take options). */
function ListRow({ title, meta, onPress, action, solid }: {
  title: string; meta?: string; onPress?: () => void; action?: string; solid?: boolean;
}) {
  const body = <View style={styles.row}>
    <View style={styles.rowText}>
      <Text style={styles.rowTitle} numberOfLines={2}>{title}</Text>
      {meta ? <Text style={styles.rowMeta} numberOfLines={1}>{meta}</Text> : null}
    </View>
    {action ? <Text style={styles.rowAction}>{action}</Text>
      : onPress ? <Image source={ICONS.chevron} style={styles.chevron} /> : null}
  </View>;
  return <View>
    {onPress ? <Pressable onPress={() => onPress()}>{body}</Pressable> : body}
    {solid ? <View style={styles.rule} /> : <Dashes />}
  </View>;
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable style={styles.primary} onPress={() => onPress()}><Text style={styles.primaryText}>{label}</Text></Pressable>;
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable style={styles.secondary} onPress={() => onPress()}><Text style={styles.secondaryText}>{label}</Text></Pressable>;
}

// Sizes are taken from the system Settings screen (1920x2560 at 300 dpi,
// 1.875 px per unit): 71-unit title bar, 294-unit tab column, 82-unit rows,
// 24/22-unit type, white page, dashed list rules, thick selection bar.
const SIDEBAR = 294;
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  header: { height: 71, backgroundColor: '#000', flexDirection: 'row', alignItems: 'center' },
  headerLeft: { width: SIDEBAR, height: 71, flexDirection: 'row', alignItems: 'center', paddingLeft: 22 },
  headerIcon: { width: 30, height: 30 },
  headerTitle: { color: '#fff', fontSize: 24, fontWeight: '500', marginLeft: 22 },
  headerCenter: { flex: 1, color: '#fff', fontSize: 24, fontWeight: '500', textAlign: 'center', paddingHorizontal: 24 },
  body: { flex: 1, flexDirection: 'row' },
  sidebar: { width: SIDEBAR, borderRightWidth: 1, borderRightColor: '#9a9a9a' },
  sideTab: { height: 82, flexDirection: 'row', alignItems: 'center', paddingLeft: 22 },
  sideIcon: { width: 30, height: 30 },
  sideLabel: { color: '#000', fontSize: 22, marginLeft: 25 },
  sideSelected: { position: 'absolute', right: -1, top: 0, bottom: 0, width: 5, backgroundColor: '#000' },
  dashes: { flexDirection: 'row', overflow: 'hidden', height: 1, marginHorizontal: 10 },
  dash: { width: 4, height: 1, marginRight: 4, backgroundColor: '#9a9a9a' },
  pane: { flex: 1 },
  paneContent: { paddingHorizontal: 29, paddingBottom: 48 },
  row: { minHeight: 82, flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  rowText: { flex: 1 },
  rowTitle: { color: '#000', fontSize: 22 },
  rowMeta: { color: '#666', fontSize: 18, marginTop: 4 },
  rowAction: { color: '#000', fontSize: 20, textDecorationLine: 'underline' },
  chevron: { width: 26, height: 26 },
  rule: { height: 1, backgroundColor: '#000' },
  section: { color: '#555', fontSize: 20, marginTop: 34, marginBottom: 6 },
  label: { color: '#555', fontSize: 20, marginTop: 28 },
  value: { color: '#000', fontSize: 22, marginTop: 8 },
  keyValue: { color: '#000', fontSize: 20, fontFamily: 'monospace', marginTop: 8, lineHeight: 28 },
  copy: { color: '#000', fontSize: 22, lineHeight: 32, marginTop: 14 },
  step: { color: '#000', fontSize: 22, fontWeight: '500', marginTop: 30 },
  qrRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 18 },
  qrCaption: { flex: 1, minWidth: 260, marginLeft: 28 },
  url: { color: '#000', fontSize: 24, fontWeight: '500', marginTop: 10 },
  input: { borderBottomWidth: 1, borderBottomColor: '#000', marginTop: 14, paddingHorizontal: 0, paddingVertical: 12, color: '#000', fontSize: 22 },
  primary: { alignSelf: 'flex-start', minWidth: 220, backgroundColor: '#000', borderRadius: 6, marginTop: 26, marginRight: 18, paddingHorizontal: 32, paddingVertical: 16, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 22, fontWeight: '500' },
  secondary: { alignSelf: 'flex-start', minWidth: 160, borderColor: '#000', borderWidth: 1.5, borderRadius: 6, marginTop: 26, marginRight: 18, paddingHorizontal: 30, paddingVertical: 15, alignItems: 'center' },
  secondaryText: { color: '#000', fontSize: 22 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap' },
  confirm: { marginTop: 10 },
  empty: { color: '#666', fontSize: 22, lineHeight: 32, marginTop: 30 },
  result: { color: '#555', fontSize: 18, lineHeight: 26, marginTop: 20 },
  status: { color: '#888', fontSize: 16, lineHeight: 24, marginTop: 40 },
});

