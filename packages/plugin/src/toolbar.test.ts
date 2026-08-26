import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Image: { resolveAssetSource: () => ({ uri: 'asset://icon' }) } }));
vi.mock('sn-plugin-lib', () => ({ PluginManager: {} }));

import { registerToolbarButtons } from './toolbar.ts';

describe('Ola Ink Share toolbar', () => {
  it('registers an enabled Share extension as its first native operation', async () => {
    const calls: string[] = [];
    await registerToolbarButtons({
      async registerButton(_type, _appTypes, button) {
        const payload = button as { id: number; enable: boolean; showType: number };
        expect(payload).toMatchObject({ id: 102, enable: true, showType: 0 });
        calls.push(`add:${payload.id}`);
        return true;
      },
      async setButtonState(id, state) { calls.push(`enable:${id}:${state}`); return true; },
    }, 'asset://icon');

    expect(calls).toEqual(['add:102', 'enable:102:true']);
  });

});
