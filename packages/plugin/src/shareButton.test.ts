import { describe, expect, it, vi } from 'vitest';

vi.mock('sn-plugin-lib', () => ({ PluginManager: {} }));
vi.mock('./playerIntent.ts', () => ({ openCurrentNoteInCompanion: vi.fn() }));

import { createShareButtonSetup } from './shareButton.ts';

describe('Ola Ink Share toolbar button', () => {
  it('adds one listener and launches only for the Share button', async () => {
    let listener: { onButtonPress(event: { id: number }): void } | null = null;
    const launch = vi.fn().mockResolvedValue(true);
    const setup = createShareButtonSetup({
      registerButtonListener(next) {
        listener = next;
        return { remove: vi.fn() };
      },
    }, 102, launch);

    setup();
    setup();
    listener!.onButtonPress({ id: 101 });
    await Promise.resolve();
    expect(launch).not.toHaveBeenCalled();

    listener!.onButtonPress({ id: 102 });
    await Promise.resolve();
    expect(launch).toHaveBeenCalledOnce();
  });
});
