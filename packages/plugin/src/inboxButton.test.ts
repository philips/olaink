import { describe, expect, it, vi } from 'vitest';

vi.mock('sn-plugin-lib', () => ({ PluginManager: {} }));

import { createInboxButtonSetup } from './inboxButton.ts';

function fakeManager() {
  const calls: string[] = [];
  let listener: { onButtonPress(event: { id: number }): void } | null = null;
  return {
    calls,
    manager: {
      registerButtonListener(next: { onButtonPress(event: { id: number }): void }) {
        calls.push('listener');
        listener = next;
        return { remove: () => calls.push('remove') };
      },
      async showPluginView() { calls.push('show'); return true; },
    },
    press: (id: number) => listener?.onButtonPress({ id }),
  };
}

describe('SwapNote inbox toolbar button', () => {
  it('adds one listener and opens the inbox view only for its button id', async () => {
    const fake = fakeManager();
    let inboxOpens = 0;
    const setup = createInboxButtonSetup(fake.manager, 102, () => { inboxOpens += 1; });

    setup();
    setup();
    expect(fake.calls).toEqual(['listener']);

    fake.press(101);
    await Promise.resolve();
    expect(inboxOpens).toBe(0);
    expect(fake.calls).toEqual(['listener']);

    fake.press(102);
    await Promise.resolve();
    expect(inboxOpens).toBe(1);
    expect(fake.calls).toEqual(['listener', 'show']);
  });
});
