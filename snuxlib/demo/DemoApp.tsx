import React, { useState } from 'react';
import {
  BodyText, ButtonRow, ConfirmPanel, EmptyText, icons, ListRow, LogPane, MonoText, PluginScreen,
  PrimaryButton, SecondaryButton, SectionLabel, StatusText, TextField, Toggle, useLog, type TabSpec,
} from '../src';

/**
 * A complete example plugin screen using every snuxlib element. Read it as
 * the reference for how the pieces fit together: tab state lives in the
 * plugin, `PluginScreen` draws the frame, each tab renders its pane inline.
 *
 *   Lists    ListRow variants, section labels, empty state
 *   Controls buttons, text field, toggles, in-screen confirmation
 *   Logs     useLog + LogPane
 *   (user)   a bottom-pinned account tab, like InkHub
 */
export default function DemoApp({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState('lists');
  const { entries, log, clear } = useLog({ initial: 'Demo started.', prefix: 'snuxlib-demo' });
  const [name, setName] = useState('');
  const [autoSave, setAutoSave] = useState(true);
  const [syncOn, setSyncOn] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [result, setResult] = useState('');

  const tabs: TabSpec[] = [
    { key: 'lists', label: 'Lists', icon: icons.inbox, onPress: () => setTab('lists') },
    { key: 'controls', label: 'Controls', icon: icons.send, onPress: () => setTab('controls') },
    { key: 'logs', label: 'Logs', icon: icons.logs, onPress: () => setTab('logs') },
    { key: 'account', label: 'demo-user', icon: icons.user, onPress: () => setTab('account'), bottom: true },
  ];
  const titles: Record<string, string> = { lists: 'Lists (3)', controls: 'Controls', logs: 'Logs', account: 'demo-user' };

  return <PluginScreen appName="snuxlib" title={titles[tab] ?? ''} onClose={onClose} tabs={tabs} activeKey={tab}>
    {tab === 'lists' && <>
      <ListRow title="Sync" onPress={() => log('Row: Sync')} solid />
      <ListRow title="Re-20261017_102323.note" meta="philips-clanker · 220 KB" onPress={() => log('Row: note opened')} />
      <ListRow title="Browser inbox" meta="inbox_d37037fbe7b246d9 · added 2026-09-23" detail="9 notes waiting"
        action="Remove" onPress={() => log('Row: Remove tapped')} solid />
      <ListRow title="Read-only row" meta="No onPress, so no chevron" />
      <SectionLabel>Empty state</SectionLabel>
      <EmptyText>No notes waiting. Share your address to receive one.</EmptyText>
      <SectionLabel>Monospace (keys, ids)</SectionLabel>
      <MonoText>MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE3UkN0JCahOQq_4fuTQGEDmazCYyR_x_GJ7lsXLd_XEBs2mznWo22U4n</MonoText>
    </>}

    {tab === 'controls' && <>
      <SectionLabel>Buttons and fields</SectionLabel>
      <BodyText>Enter a name, then use the buttons. Every action is written to the Logs tab.</BodyText>
      <TextField value={name} onChangeText={setName} placeholder="A name" />
      <ButtonRow>
        <PrimaryButton label="Save" onPress={() => { setResult(`Saved "${name}".`); log(`Save: "${name}"`); }} />
        <SecondaryButton label="Reset" onPress={() => { setName(''); setResult(''); log('Reset'); }} />
      </ButtonRow>
      {result ? <StatusText>{result}</StatusText> : null}
      <SectionLabel>Toggles</SectionLabel>
      <Toggle label="Save notes automatically" subtext="Notes are written to Note/OlaInk as they arrive."
        value={autoSave} onChange={next => { setAutoSave(next); log(`Auto-save ${next ? 'on' : 'off'}`); }} />
      <Toggle label="Sync into Digest" subtext="Locked while Read-only mode is on." value={syncOn} onChange={setSyncOn} disabled />
      <SectionLabel>In-screen confirmation</SectionLabel>
      {removed ? <StatusText>Removed. (Cancel resets this demo.)</StatusText> : null}
      {!confirming && <SecondaryButton label={removed ? 'Undo remove' : 'Remove device…'}
        onPress={() => { if (removed) { setRemoved(false); log('Undo'); } else setConfirming(true); }} />}
      {confirming && <ConfirmPanel destructive title="Remove this device?"
        message="It stops receiving notes immediately; notes still waiting for it are discarded."
        confirmLabel="Remove" onCancel={() => { setConfirming(false); log('Remove cancelled'); }}
        onConfirm={() => { setConfirming(false); setRemoved(true); log('Removed'); }} />}
    </>}

    {tab === 'logs' && <LogPane entries={entries} onClear={clear}
      diagnostics={['App snuxlib demo', 'Version 0.1.0', `Tab ${tab}`]} />}

    {tab === 'account' && <>
      <SectionLabel>This Supernote</SectionLabel>
      <BodyText>Paired with demo-user.</BodyText>
      <SectionLabel>Account devices (2)</SectionLabel>
      <ListRow title="Browser inbox" meta="inbox_627aa4… · added 2026-09-23" detail="2 notes waiting" action="Remove"
        onPress={() => log('Account: Remove tapped')} solid />
      <ListRow title="This Supernote" meta="device_e2_xe7vlxym · added 2026-10-17" detail="0 notes waiting" solid />
      <SectionLabel>Account</SectionLabel>
      <ListRow title="Log out" meta="Pair again to use a different account" onPress={() => log('Account: Log out tapped')} solid />
    </>}
  </PluginScreen>;
}
