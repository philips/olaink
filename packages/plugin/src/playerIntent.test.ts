import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Linking: {} }));

import {
  COMPANION_DRAFT_ID_EXTRA,
  COMPANION_SHARE_ACTION,
  openCompanionShare,
} from './playerIntent.ts';

describe('companion share intent', () => {
  it('launches the wrapper with only an opaque draft identifier', async () => {
    const sendIntent = vi.fn().mockResolvedValue(undefined);

    await expect(openCompanionShare('fixture-draft', { sendIntent })).resolves.toBe(true);
    expect(sendIntent).toHaveBeenCalledWith(COMPANION_SHARE_ACTION, [
      { key: COMPANION_DRAFT_ID_EXTRA, value: 'fixture-draft' },
    ]);
    expect(JSON.stringify(sendIntent.mock.calls)).not.toContain(['note', 'Path'].join(''));
  });

  it('reports a missing or blocked companion without crashing the plugin', async () => {
    const sendIntent = vi.fn().mockRejectedValue(new Error('IntentAndroid unavailable'));
    await expect(openCompanionShare('probe', { sendIntent })).resolves.toBe(false);
  });
});
