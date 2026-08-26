import { PluginManager } from 'sn-plugin-lib';
import { BUTTON_ID } from './buttonIds.ts';
import { openCurrentNoteInCompanion } from './playerIntent.ts';

export interface ShareButtonManager {
  registerButtonListener(listener: { onButtonPress(event: { id: number }): void }): { remove(): void };
}

/** Register one headless listener per plugin runtime for the in-note Share button. */
export function createShareButtonSetup(
  manager: ShareButtonManager,
  shareButtonId: number,
  launch: () => Promise<boolean> = () => openCurrentNoteInCompanion(),
): () => void {
  let subscription: { remove(): void } | null = null;
  return (): void => {
    if (subscription !== null) return;
    subscription = manager.registerButtonListener({
      onButtonPress: (event) => {
        if (event.id !== shareButtonId) return;
        void launch();
      },
    });
  };
}

const setupShareButton = createShareButtonSetup(PluginManager, BUTTON_ID.share);

export function registerShareButtonListener(): void {
  setupShareButton();
}
