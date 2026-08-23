/** Supernote Plugin Manager configuration-button entry point. */

import { PluginManager } from 'sn-plugin-lib';

export interface ConfigButtonManager {
  registerConfigButton(): Promise<boolean>;
  registerConfigButtonListener(listener: { onClick(): void }): { remove(): void };
  showPluginView(): Promise<boolean>;
}

/**
 * Creates an idempotent setup function for one plugin JS runtime.
 *
 * Supernote requires the native config button to be registered before its
 * listener. A failed registration is deliberately retryable; normal repeated
 * startup calls reuse the same in-flight/completed setup promise.
 */
export function createConfigButtonSetup(manager: ConfigButtonManager): () => Promise<boolean> {
  let setup: Promise<boolean> | null = null;
  let subscription: { remove(): void } | null = null;

  return (): Promise<boolean> => {
    if (setup !== null) return setup;
    setup = (async () => {
      const registered = await manager.registerConfigButton();
      if (!registered) {
        setup = null;
        return false;
      }
      if (subscription === null) {
        subscription = manager.registerConfigButtonListener({
          onClick: () => {
            void manager.showPluginView().catch((error: Error) => {
              console.log(`[wrtn] config view failed: ${error.message}`);
            });
          },
        });
      }
      return true;
    })().catch((error: unknown) => {
      setup = null;
      throw error;
    });
    return setup;
  };
}

const setupConfigButton = createConfigButtonSetup(PluginManager);

/** Register the Plugin Manager entry point without failing plugin startup. */
export async function registerPluginManagerConfigButton(): Promise<boolean> {
  try {
    const registered = await setupConfigButton();
    if (!registered) console.log('[wrtn] Plugin Manager config button registration returned false');
    return registered;
  } catch (error) {
    console.log(`[wrtn] Plugin Manager config button registration failed: ${(error as Error).message}`);
    return false;
  }
}
