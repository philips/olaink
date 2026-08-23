import { describe, expect, it, vi } from 'vitest';

vi.mock('sn-plugin-lib', () => ({ PluginManager: {} }));

import { createConfigButtonSetup } from './configButton.ts';

function fakeManager(opts: { register?: () => Promise<boolean> } = {}) {
  const calls: string[] = [];
  let listener: { onClick(): void } | null = null;
  return {
    calls,
    manager: {
      registerConfigButton: async () => {
        calls.push('register');
        return opts.register === undefined ? true : opts.register();
      },
      registerConfigButtonListener: (next: { onClick(): void }) => {
        calls.push('listener');
        listener = next;
        return { remove: () => { calls.push('remove'); } };
      },
      showPluginView: async () => { calls.push('show'); return true; },
    },
    click: () => listener?.onClick(),
  };
}

describe('Plugin Manager config button', () => {
  it('registers the button before adding one listener, then opens the setup view', async () => {
    const fake = fakeManager();
    const setup = createConfigButtonSetup(fake.manager);

    await expect(setup()).resolves.toBe(true);
    expect(fake.calls).toEqual(['register', 'listener']);

    fake.click();
    await Promise.resolve();
    expect(fake.calls).toEqual(['register', 'listener', 'show']);
  });

  it('is idempotent across repeated startup calls', async () => {
    const fake = fakeManager();
    const setup = createConfigButtonSetup(fake.manager);

    await Promise.all([setup(), setup(), setup()]);
    expect(fake.calls).toEqual(['register', 'listener']);
  });

  it('does not add a listener when native registration returns false and retries later', async () => {
    let attempts = 0;
    const fake = fakeManager({ register: async () => ++attempts > 1 });
    const setup = createConfigButtonSetup(fake.manager);

    await expect(setup()).resolves.toBe(false);
    await expect(setup()).resolves.toBe(true);
    expect(fake.calls).toEqual(['register', 'register', 'listener']);
  });

  it('allows retry after a thrown registration failure', async () => {
    let attempts = 0;
    const fake = fakeManager({ register: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary failure');
      return true;
    } });
    const setup = createConfigButtonSetup(fake.manager);

    await expect(setup()).rejects.toThrow('temporary failure');
    await expect(setup()).resolves.toBe(true);
    expect(fake.calls).toEqual(['register', 'register', 'listener']);
  });
});
