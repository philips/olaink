import React, { useEffect, useRef, useState } from 'react';
import { AppQrCode, APP_URL } from './src/appQrCode';
import { NativeModules, StyleSheet, Text, View } from 'react-native';
import { PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI } from 'sn-plugin-lib';
import {
  BodyText, ButtonRow, EmptyText, formatBytes, formatDay, icons, ListRow, LogPane, MonoText, PluginScreen,
  PrimaryButton, SecondaryButton, SectionLabel, StatusText, TextField, theme, useLog, type TabSpec,
} from 'snuxlib';

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

/** One device enrolled on the account, as reported by the relay inventory. */
interface AccountDevice {
  deviceId: string;
  publicKeySpki: string;
  /** Epoch ms of first enrollment. */
  addedAt: number;
  /** Notes still queued for this device. */
  pending: number;
}

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

/** Best-effort human label from a device ID prefix (device_e2_ = Supernote companion, inbox_ = browser). */
const deviceLabel = (deviceId: string) => deviceId.startsWith('device_e2_') ? 'Supernote'
  : deviceId.startsWith('inbox_') ? 'Browser inbox' : 'Device';

const FILE_WRITE = 'plugin.permission.FILE:WRITE';

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
  // Every status/result/error line the plugin produces. The Logs tab is the one
  // place users read (and send us) debug information from.
  const { entries: logEntries, log, clear: clearLog } = useLog({ initial: 'Loading Ola Ink…', prefix: 'olaink' });
  // The pairing form's inline result: a rejected code must be visible next to the field.
  const [pairMessage, setPairMessage] = useState('');
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  // null until the NPK reports whether this Supernote holds a device session.
  const [paired, setPaired] = useState<boolean | null>(null);
  const [pairedUsername, setPairedUsername] = useState('');
  const [code, setCode] = useState('');
  const [recipient, setRecipient] = useState('');
  const [activeNoteName, setActiveNoteName] = useState('No open note detected.');
  const [inbox, setInbox] = useState<RelayRecord[]>([]);
  const [journalInbox, setJournalInbox] = useState<JournalEntry[]>([]);
  const [sent, setSent] = useState<JournalEntry[]>([]);
  const [muted, setMuted] = useState<string[]>([]);
  const [muteName, setMuteName] = useState('');
  const [recentOpen, setRecentOpen] = useState(false);
  const [tab, setTab] = useState('inbox');
  const [sendConfirm, setSendConfirm] = useState(false);
  const [accountDevices, setAccountDevices] = useState<AccountDevice[] | null>(null);
  const [ownDeviceId, setOwnDeviceId] = useState('');
  const [removeTarget, setRemoveTarget] = useState<AccountDevice | null>(null);
  // The device session is native-persisted but enters JS only for this foreground
  // React transport session. It is never rendered or placed in AsyncStorage.
  const session = useRef<SessionState | null>(null);
  // Read by the plugin-life listener, which is registered once.
  const lastPollFailure = useRef('');
  // Automatic receive: one run at a time, ask for FILE:WRITE once per session,
  // never retry a record that failed to decrypt (the relay keeps it), and know
  // which records are already saved so a lost ack is only re-sent.
  const receiving = useRef(false);
  const askedFileWrite = useRef(false);
  const failedRecords = useRef(new Set<string>());
  const lastReceiveFailure = useRef('');
  const savedRecordIds = useRef(new Set<string>());
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
    setPairMessage('');
    log('Pair: requesting INTERNET…');
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
        setOwnDeviceId(identity.deviceId);
        loadJournal();
        refreshInbox(true);
        loadAccountDevices();
        log('Pair: this Supernote is paired.');
      })
      .catch(error => {
        const failure = pairingFailure(message(error));
        setPairMessage(failure);
        log(`Pair: FAIL ${message(error)}`);
      });
  };

  const checkPaired = () => void nativeClient.e2Status()
    .then((raw: string) => {
      const status = JSON.parse(raw);
      setPaired(status.paired === true);
      setPairedUsername(typeof status.username === 'string' ? status.username : '');
      if (typeof status.deviceId === 'string' && status.deviceId) setOwnDeviceId(status.deviceId);
    })
    .catch((error: unknown) => { setPaired(false); log(`Status: FAIL ${message(error)}`); });

  const loadJournal = () => void nativeClient.e2Journal()
    .then((raw: string) => {
      const journal = JSON.parse(raw);
      const savedEntries: JournalEntry[] = Array.isArray(journal.inbox) ? journal.inbox : [];
      savedRecordIds.current = new Set(savedEntries.map(entry => String(entry.id)));
      setJournalInbox(newestFirst(savedEntries));
      setSent(newestFirst(Array.isArray(journal.sent) ? journal.sent : []));
      setMuted(Array.isArray(journal.muted) ? journal.muted : []);
    })
    .catch((error: unknown) => log(`Journal: FAIL ${message(error)}`));

  const setMutedUser = (mutedValue: boolean, explicitName = muteName) => {
    void nativeClient.e2SetMuted(explicitName.trim(), mutedValue)
      .then((raw: string) => {
        const journal = JSON.parse(raw);
        setMuted(Array.isArray(journal.muted) ? journal.muted : []);
        setMuteName('');
      })
      .catch((error: unknown) => log(`Mute: FAIL ${message(error)}`));
  };

  /**
   * Decrypts and saves every waiting note into Note/OlaInk, then acknowledges
   * it, so notes just appear in the Inbox list with nothing to tap. Needs
   * FILE:WRITE: used silently when already granted, asked for once per session
   * otherwise (the fallback rows below stay tappable if the user declines).
   */
  const receiveWaiting = async (records: RelayRecord[], active: SessionState) => {
    const pending = records.filter(record => !failedRecords.current.has(String(record.id)));
    if (receiving.current || pending.length === 0) return;
    receiving.current = true;
    try {
      if (await PluginManager.hasPermission(FILE_WRITE) !== 1) {
        if (askedFileWrite.current) return;
        askedFileWrite.current = true;
        const granted = await PluginManager.requestPermission(FILE_WRITE,
          'Ola Ink saves the notes you receive into the Note/OlaInk folder.');
        if (!granted) {
          log('Receive: FILE:WRITE was denied; notes wait in the Inbox until you allow saving.');
          return;
        }
      }
      for (const record of pending) {
        const id = String(record.id);
        try {
          if (!savedRecordIds.current.has(id)) {
            const result = JSON.parse(await nativeClient.e2ReceiveRecord(JSON.stringify(record)));
            savedRecordIds.current.add(id);
            log(result.muted ? `Receive: kept a note from a muted sender encrypted (${formatBytes(Number(result.noteBytes))}).`
              : `Receive: saved ${result.filename} (${formatBytes(Number(result.noteBytes))}).`);
          }
          // Only acknowledged after the note is saved and journaled.
          await relayPost('/v1/companion/ack', { deviceId: active.deviceId, recordIds: [id] }, active.sessionToken);
          setInbox(previous => previous.filter(item => String(item.id) !== id));
          loadJournal();
        } catch (error) {
          // An undecryptable record stays on the relay; do not retry it every poll.
          failedRecords.current.add(id);
          log(`Receive: FAIL ${id}: ${message(error)}`);
        }
      }
    } catch (error) {
      // Same error on every 10 s poll: log it once.
      const failure = message(error);
      if (lastReceiveFailure.current !== failure) log(`Receive: FAIL ${failure}`);
      lastReceiveFailure.current = failure;
    } finally {
      receiving.current = false;
    }
  };

  const refreshInbox = (silent = false) => {
    if (!silent) log('Inbox: refreshing…');
    void currentSession()
      .then(async active => {
        const result = await relayPost('/v1/companion/poll', { deviceId: active.deviceId }, active.sessionToken);
        const records: RelayRecord[] = Array.isArray(result.records) ? result.records : [];
        lastPollFailure.current = '';
        setInbox(records);
        if (!silent) log(`Inbox: ${records.length} encrypted record(s) waiting.`);
        void receiveWaiting(records, active);
      })
      .catch(error => {
        const failure = message(error);
        // Background polls run every 10 s: log a new failure once, not each time.
        if (!silent || lastPollFailure.current !== failure) log(`Inbox: FAIL ${failure}`);
        lastPollFailure.current = failure;
      });
  };

  const logout = () => {
    log('Logout: ending staging session…');
    void currentSession()
      .then(async active => {
        await relayPost('/v1/companion/logout', { deviceId: active.deviceId }, active.sessionToken);
        await nativeClient.e2ClearLocal();
        session.current = null;
        setInbox([]);
        setPaired(false);
        setPairedUsername('');
        return '';
      })
      .then(log)
      .catch(error => log(`Logout: FAIL ${message(error)}`));
  };

  const loadAccountDevices = () => {
    void currentSession()
      .then(async active => {
        const response = await relayPost('/v1/companion/devices', { deviceId: active.deviceId }, active.sessionToken);
        const result = response as { devices: AccountDevice[] };
        setOwnDeviceId(active.deviceId);
        setAccountDevices(result.devices);
        setRemoveTarget(null);
      })
      .catch(error => log(`Devices: FAIL ${message(error)}`));
  };

  const removeAccountDevice = () => {
    const target = removeTarget;
    if (!target) return;
    log(`Remove: removing ${target.deviceId}…`);
    void currentSession()
      .then(async active => {
        await relayPost('/v1/companion/devices/remove', {
          deviceId: active.deviceId, targetDeviceId: target.deviceId,
        }, active.sessionToken);
        setAccountDevices(previous => (previous ?? []).filter(device => device.deviceId !== target.deviceId));
        setRemoveTarget(null);
        return `Removed ${deviceLabel(target.deviceId)} ${target.deviceId}.`;
      })
      .then(log)
      .catch(error => log(`Remove: FAIL ${message(error)}`));
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

  const openSettingsTab = () => {
    setTab('settings');
    loadAccountDevices();
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
    log('Inspect: requesting FILE:READ…');
    void PluginManager.requestPermission('plugin.permission.FILE:READ',
      'Inspect the saved current note for the disposable F0 file-contract probe.')
      .then(async granted => {
        if (!granted) throw new Error('FILE:READ was denied');
        const path = await currentNotePath();
        return nativeClient.f0InspectCurrentNote(path);
      })
      .then(result => log(`Inspect: ${result}`))
      .catch(error => log(`Inspect: FAIL ${message(error)}`));
  };

  const sendCurrentNote = () => {
    log('Send: requesting FILE:READ…');
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
      .then(result => { loadJournal(); log(`Send: ${JSON.stringify(result)}`); })
      .catch(error => log(`Send: FAIL ${message(error)}`));
  };

  const copyAndOpenCurrentNote = () => {
    log('Copy: requesting FILE:READ and FILE:WRITE…');
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
      .then(result => log(`Copy: ${JSON.stringify(result)}`))
      .catch(error => log(`Copy: FAIL ${message(error)}`));
  };

  const saveAndOpenInboxNote = (selectedRecord: RelayRecord | null) => {
    log('Receive: requesting FILE:WRITE…');
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
      .then(result => log(`Receive: ${JSON.stringify(result)}`))
      .catch(error => log(`Receive: FAIL ${message(error)}`));
  };

  const reopenStoredInboxNote = (recordId: string) => {
    log('Inbox: opening saved note…');
    void PluginManager.requestPermission('plugin.permission.FILE:WRITE',
      'Write this encrypted Inbox note into the OlaInk Note folder and open it.')
      .then(async granted => {
        if (!granted) throw new Error('FILE:WRITE was denied');
        const result = JSON.parse(await nativeClient.e2DecryptStoredRecordToNote(recordId));
        loadJournal();
        const opened = (await PluginFileAPI.openFile(result.destinationPath, -1)) as HostResponse | null;
        if (!opened?.success) throw new Error('Supernote could not open saved note');
      })
      .catch(error => log(`Inbox: FAIL ${message(error)}`));
  };

  const requestInternet = () => {
    void PluginManager.requestPermission(INTERNET,
      'Ola Ink needs network access to app.olaink.com for pairing and note delivery.')
      .then(value => log(`INTERNET consent returned ${value}.`))
      .catch(error => log(`INTERNET consent failed: ${message(error)}`));
  };

  // F2 transport probe: this is deliberately React Native fetch, not the old
  // NPK RelayClient. It requires a WebPKI-valid Tailscale certificate; React
  // Native fetch has no supported leaf-pinning hook for the self-signed relay.
  const probeReactRelay = () => {
    log('React relay probe: requesting INTERNET…');
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
      .then(log)
      .catch(error => log(`React relay probe: FAIL ${message(error)}`));
  };

  useEffect(() => {
    if (!nativeClient?.describe) return log('FAIL: native NPK is unavailable.');
    void nativeClient.describe()
      .then((info: { nativeRevision?: number; apiLevel?: number; pluginId?: string }) => {
        setDiagnostics([`Native revision ${info?.nativeRevision ?? '?'}`, `Android API ${info?.apiLevel ?? '?'}`,
          `Plugin ${info?.pluginId ?? '?'}`]);
        log('Ready.');
        checkPaired();
        loadJournal();
      })
      .catch((error: unknown) => log(`FAIL: ${message(error)}`));
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
        loadJournal();
        refreshInbox(true);
        if (tabRef.current === 'send') refreshActiveNote();
      },
    });
    return () => { clearInterval(interval); life.remove(); };
  }, []);

  const close = () => PluginManager.closePluginView();
  const visibleInbox = journalInbox.filter(item => !muted.includes(String(item.sender || '').toLowerCase()));
  const showLogs = tab === 'logs';
  const accountLabel = pairedUsername || 'Account';
  const paneTitle = showLogs ? 'Logs' : paired === false ? 'Set up Ola Ink'
    : tab === 'inbox' ? `Inbox (${inbox.length + visibleInbox.length})`
      : tab === 'send' ? 'Send a note' : accountLabel;
  const sideTabs: TabSpec[] = paired === true
    ? [
      { key: 'inbox', label: 'Inbox', icon: icons.inbox, onPress: () => setTab('inbox') },
      { key: 'send', label: 'Send', icon: icons.send, onPress: openSendTab },
      { key: 'logs', label: 'Logs', icon: icons.logs, onPress: () => setTab('logs') },
      // Like InkHub: the account (user and device settings) is a tab at the
      // bottom of the sidebar, labelled with the username.
      { key: 'settings', label: accountLabel, icon: icons.user, onPress: openSettingsTab, bottom: true },
    ]
    : [
      { key: 'pair', label: 'Pair', icon: icons.pair, onPress: () => setTab('inbox') },
      { key: 'logs', label: 'Logs', icon: icons.logs, onPress: () => setTab('logs') },
    ];
  const activeKey = showLogs ? 'logs' : paired === true ? tab : 'pair';

  return <PluginScreen appName="Ola Ink" title={paneTitle} onClose={close} tabs={sideTabs} activeKey={activeKey}>
    {paired === false && !showLogs && <View>
      {/* The code field sits near the top: the on-screen keyboard covers the
          lower part of the screen while typing. */}
      <BodyText>Enter the eight-digit pairing code from app.olaink.com to pair this Supernote.</BodyText>
      <TextField value={code} onChangeText={setCode} placeholder="1234-5678" keyboardType="numeric" />
      <PrimaryButton label="Pair this Supernote" onPress={claimPairingCode} />
      {pairMessage ? <StatusText>{pairMessage}</StatusText> : null}

      <SectionLabel>Need a pairing code?</SectionLabel>
      <Text style={styles.step}>1. On your phone or computer, open Ola Ink</Text>
      <View style={styles.qrRow}>
        <AppQrCode moduleSize={8} />
        <View style={styles.qrCaption}>
          <BodyText>Scan this code with your phone's camera, or type the address:</BodyText>
          <Text style={styles.url}>{APP_URL.replace('https://', '')}</Text>
        </View>
      </View>
      <Text style={styles.step}>2. Sign in, or create an account</Text>
      <BodyText>Use Sign in with passkey if you already have an account.</BodyText>
      <Text style={styles.step}>3. Choose Add Supernote companion</Text>
      <BodyText>The site shows an eight-digit code. It works once and expires after 10 minutes. Enter it at the top of this screen.</BodyText>
    </View>}

    {paired === true && tab === 'inbox' && <View>
      <ListRow title="Sync inbox" onPress={refreshInbox} solid />
      {[...inbox].reverse().map((item, index) => <ListRow key={`${index}-${String(item.id)}`}
        title={`Encrypted note ${index + 1}`} meta="Waiting · tap to save and open in Notes" onPress={() => saveAndOpenInboxNote(item)} />)}
      {visibleInbox.map(item => <ListRow key={item.id} title={String(item.filename)}
        meta={`${item.sender} · ${formatBytes(Number(item.bytes))}`} onPress={() => reopenStoredInboxNote(item.id)} />)}
      {inbox.length === 0 && visibleInbox.length === 0 && <EmptyText>No notes waiting. Share your Ola Ink address to receive a note.</EmptyText>}
    </View>}

    {paired === true && tab === 'send' && <View>
      <Text style={styles.label}>Current note</Text>
      <Text style={styles.value}>{activeNoteName || 'No note open'}</Text>
      <Text style={styles.label}>Send to</Text>
      <TextField value={recipient} onChangeText={setRecipient} placeholder="Ola Ink address" />
      {recentUsers.length > 0 && <View>
        <ListRow title={`Recent (${recentUsers.length})`} onPress={() => setRecentOpen(value => !value)} solid />
        {recentOpen && recentUsers.map(user => <ListRow key={user.name} title={user.name}
          onPress={() => { setRecipient(user.name); setRecentOpen(false); }} />)}
      </View>}
      {!sendConfirm
        ? <PrimaryButton label="Continue" onPress={() => setSendConfirm(true)} />
        : <View style={styles.confirm}>
          <BodyText>Send the current saved note to {recipient || 'this recipient'}?</BodyText>
          <ButtonRow>
            <PrimaryButton label="Encrypt and send" onPress={() => { setSendConfirm(false); sendCurrentNote(); }} />
            <SecondaryButton label="Cancel" onPress={() => setSendConfirm(false)} />
          </ButtonRow>
        </View>}
      {sent.length > 0 && <SectionLabel>{`Sent (${sent.length})`}</SectionLabel>}
      {sent.map(item => <ListRow key={item.id} title={String(item.filename)} meta={`To ${item.recipient}`} />)}
    </View>}

    {paired === true && tab === 'settings' && <View>
      <SectionLabel>This Supernote</SectionLabel>
      <BodyText>{pairedUsername ? `Paired with ${pairedUsername}.` : 'Paired with your Ola Ink account.'}</BodyText>
      <SectionLabel>{`Account devices (${accountDevices ? accountDevices.length : '…'})`}</SectionLabel>
      <BodyText>Public keys enrolled on {pairedUsername ? `@${pairedUsername}` : 'this account'}. Removing a device stops new notes from reaching it; notes still waiting for it are discarded.</BodyText>
      {accountDevices === null ? <EmptyText>Device list not loaded.</EmptyText>
        : accountDevices.map(device => {
          const own = device.deviceId === ownDeviceId;
          const added = formatDay(device.addedAt);
          const meta = `${device.deviceId}${added ? ` · added ${added}` : ''}`;
          // Its own line: how many notes are queued is what tells the user whether a key is in use.
          const detail = `${device.pending} note${device.pending === 1 ? '' : 's'} waiting`;
          return <View key={device.deviceId}>
            {own
              ? <ListRow title="This Supernote" meta={meta} detail={detail} solid />
              : <ListRow title={deviceLabel(device.deviceId)} meta={meta} detail={detail}
                  onPress={() => setRemoveTarget(device)} action="Remove" solid />}
            <MonoText>{device.publicKeySpki}</MonoText>
          </View>;
        })}
      {removeTarget && <View style={styles.confirm}>
        <BodyText>Remove {deviceLabel(removeTarget.deviceId)} {removeTarget.deviceId}?</BodyText>
        <BodyText>{removeTarget.pending > 0 ? `${removeTarget.pending} note${removeTarget.pending > 1 ? 's' : ''} still waiting for it will be discarded. ` : ''}It stops receiving notes immediately; pair it again to enroll a new key.</BodyText>
        <ButtonRow>
          <PrimaryButton label="Remove" onPress={removeAccountDevice} />
          <SecondaryButton label="Cancel" onPress={() => setRemoveTarget(null)} />
        </ButtonRow>
      </View>}
      <SectionLabel>{`Muted users (${muted.length})`}</SectionLabel>
      <BodyText>Notes from muted users stay encrypted on this Supernote but are hidden from Inbox.</BodyText>
      <TextField value={muteName} onChangeText={setMuteName} placeholder="Ola Ink address" />
      <SecondaryButton label="Mute user" onPress={() => setMutedUser(true)} />
      {muted.map(name => <ListRow key={name} title={name} action="Unmute" onPress={() => setMutedUser(false, name)} />)}
      <SectionLabel>Account</SectionLabel>
      <ListRow title="Log out this Supernote" meta="Pair again to use a different account" onPress={logout} solid />
    </View>}

    {showLogs && <LogPane entries={logEntries} onClear={clearLog} diagnostics={[
      `Paired: ${paired === null ? 'unknown' : paired ? `yes${pairedUsername ? ` (${pairedUsername})` : ''}` : 'no'}`,
      ...(ownDeviceId ? [`Device ${ownDeviceId}`] : []),
      ...diagnostics,
    ]} />}
  </PluginScreen>;
}

const { color } = theme;
const styles = StyleSheet.create({
  label: { color: color.muted, fontSize: 20, marginTop: 28 },
  value: { color: color.ink, fontSize: 22, marginTop: 8 },
  step: { color: color.ink, fontSize: 22, fontWeight: '500', marginTop: 30 },
  qrRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 18 },
  qrCaption: { flex: 1, minWidth: 260, marginLeft: 28 },
  url: { color: color.ink, fontSize: 24, fontWeight: '500', marginTop: 10 },
  confirm: { marginTop: 10 },
});
