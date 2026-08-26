import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Linking: {} }));
vi.mock('sn-plugin-lib', () => ({
  PluginCommAPI: { getCurrentFilePath: vi.fn() },
}));

import {
  COMPANION_DRAFT_ID_EXTRA,
  COMPANION_NOTE_PATH_EXTRA,
  COMPANION_SHARE_ACTION,
  openCompanionShare,
  openCurrentNoteInCompanion,
} from './playerIntent.ts';

describe('companion share intent', () => {
  it('includes the active note path when it is available', async () => {
    const sendIntent = vi.fn().mockResolvedValue(undefined);

    await expect(openCompanionShare('fixture-draft', { sendIntent }, '/storage/emulated/0/Note/letter.note'))
      .resolves.toBe(true);
    expect(sendIntent).toHaveBeenCalledWith(COMPANION_SHARE_ACTION, [
      { key: COMPANION_DRAFT_ID_EXTRA, value: 'fixture-draft' },
      { key: COMPANION_NOTE_PATH_EXTRA, value: '/storage/emulated/0/Note/letter.note' },
    ]);
  });

  it('gets the active path before launching the companion', async () => {
    const sendIntent = vi.fn().mockResolvedValue(undefined);
    const getCurrentFilePath = vi.fn().mockResolvedValue({
      success: true,
      result: '/storage/emulated/0/Note/letter.note',
    });

    await expect(openCurrentNoteInCompanion('fixture-draft', { sendIntent }, { getCurrentFilePath }))
      .resolves.toBe(true);
    expect(getCurrentFilePath).toHaveBeenCalledOnce();
    expect(sendIntent).toHaveBeenCalledWith(COMPANION_SHARE_ACTION, [
      { key: COMPANION_DRAFT_ID_EXTRA, value: 'fixture-draft' },
      { key: COMPANION_NOTE_PATH_EXTRA, value: '/storage/emulated/0/Note/letter.note' },
    ]);
  });

  it('reports a missing or blocked companion without crashing the plugin', async () => {
    const sendIntent = vi.fn().mockRejectedValue(new Error('IntentAndroid unavailable'));
    await expect(openCompanionShare('probe', { sendIntent })).resolves.toBe(false);
  });
});
