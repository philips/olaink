import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Image: { resolveAssetSource: () => ({ uri: 'asset://icon' }) } }));
vi.mock('sn-plugin-lib', () => ({ PluginManager: {} }));

import { registerToolbarButtons } from './toolbar.ts';

describe('Ola Ink Share toolbar', () => {
  it('refreshes the persisted Share button before registering it', async () => {
    const calls: string[] = [];
    await registerToolbarButtons({
      async unregisterButton(id) { calls.push(`remove:${id}`); return true; },
      async registerButton(_type, _appTypes, button) {
        calls.push(`add:${(button as { id: number }).id}`);
        return true;
      },
    }, 'asset://icon');

    expect(calls).toEqual(['remove:102', 'add:102']);
  });

  it('still registers Share when no existing entry can be removed', async () => {
    const calls: string[] = [];
    await registerToolbarButtons({
      async unregisterButton() { throw new Error('not found'); },
      async registerButton() { calls.push('add'); return true; },
    }, 'asset://icon');

    expect(calls).toEqual(['add']);
  });
});
