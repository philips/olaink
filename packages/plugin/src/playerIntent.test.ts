import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Linking: {} }));
vi.mock('sn-plugin-lib', () => ({ PluginCommAPI: {} }));

import {
  COMPANION_DRAFT_ID_EXTRA,
  COMPANION_NOTE_PATH_EXTRA,
  COMPANION_SHARE_ACTION,
  openCompanionShare,
  openCurrentNoteInCompanion,
} from './playerIntent.ts';

describe('companion share intent', () => {
  it('launches the wrapper with only an opaque draft identifier', async () => {
    const sendIntent = vi.fn().mockResolvedValue(undefined);

    await expect(openCompanionShare('fixture-draft', { sendIntent })).resolves.toBe(true);
    expect(sendIntent).toHaveBeenCalledWith(COMPANION_SHARE_ACTION, [
      { key: COMPANION_DRAFT_ID_EXTRA, value: 'fixture-draft' },
    ]);
  });

  it('forwards the current note path only in the explicitly unsafe prototype flow', async () => {
    const sendIntent = vi.fn().mockResolvedValue(undefined);
    const getCurrentFilePath = vi.fn().mockResolvedValue({ success: true, result: '/storage/emulated/0/Note/test.note' });

    await expect(openCurrentNoteInCompanion('prototype', { sendIntent }, { getCurrentFilePath })).resolves.toBe(true);
    expect(sendIntent).toHaveBeenCalledWith(COMPANION_SHARE_ACTION, [
      { key: COMPANION_DRAFT_ID_EXTRA, value: 'prototype' },
      { key: COMPANION_NOTE_PATH_EXTRA, value: '/storage/emulated/0/Note/test.note' },
    ]);
  });

  it('reports a missing or blocked companion without crashing the plugin', async () => {
    const sendIntent = vi.fn().mockRejectedValue(new Error('IntentAndroid unavailable'));
    await expect(openCompanionShare('probe', { sendIntent })).resolves.toBe(false);
  });
});
