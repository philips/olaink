import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Image: { resolveAssetSource: () => ({ uri: 'asset://icon' }) } }));
vi.mock('sn-plugin-lib', () => ({ PluginManager: {} }));

import { LEGACY_SETUP_BUTTON_ID, registerToolbarButtons } from './toolbar.ts';

describe('SwapNote toolbar', () => {
  it('removes the persisted setup button before registering the inbox button', async () => {
    const calls: string[] = [];
    await registerToolbarButtons({
      async unregisterButton(id) { calls.push(`remove:${id}`); return true; },
      async registerButton(_type, _appTypes, button) {
        calls.push(`add:${(button as { id: number }).id}`);
        return true;
      },
    }, 'asset://icon');

    expect(LEGACY_SETUP_BUTTON_ID).toBe(101);
    expect(calls).toEqual(['remove:101', 'add:102']);
  });

  it('still registers SwapNote when the old entry cannot be removed', async () => {
    const calls: string[] = [];
    await registerToolbarButtons({
      async unregisterButton() { throw new Error('not found'); },
      async registerButton() { calls.push('add'); return true; },
    }, 'asset://icon');

    expect(calls).toEqual(['add']);
  });
});
