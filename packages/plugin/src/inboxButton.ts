/** Opens the pending-SwapNote inbox view from the headless toolbar button. */

import { PluginManager } from 'sn-plugin-lib';
import { BUTTON_ID } from './buttonIds.ts';
import { setPluginViewMode } from './viewMode.ts';

export interface InboxButtonManager {
  registerButtonListener(listener: { onButtonPress(event: { id: number }): void }): { remove(): void };
  showPluginView(): Promise<boolean>;
}

/** Set up one listener per JS runtime; PluginManager replays an early click. */
export function createInboxButtonSetup(
  manager: InboxButtonManager,
  deliveryButtonId: number,
  openInbox: () => void = () => setPluginViewMode('inbox'),
): () => void {
  let subscription: { remove(): void } | null = null;
  return (): void => {
    if (subscription !== null) return;
    subscription = manager.registerButtonListener({
      onButtonPress: (event) => {
        if (event.id !== deliveryButtonId) return;
        openInbox();
        void manager.showPluginView().catch((error: Error) => {
          console.log(`[wrtn] SwapNote inbox view failed: ${error.message}`);
        });
      },
    });
  };
}

const setupInboxButton = createInboxButtonSetup(PluginManager, BUTTON_ID.delivery);

export function registerInboxButtonListener(): void {
  setupInboxButton();
}
