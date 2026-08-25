/** Ola Ink Share toolbar wiring, including migration from the old SwapNote item. */

import { Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import { BUTTON_ID } from './buttonIds.ts';

/** Persisted by older plugin versions; remove it after an in-place upgrade. */
export const LEGACY_SETUP_BUTTON_ID = 101;

export interface ToolbarManager {
  unregisterButton(id: number): Promise<boolean>;
  registerButton(type: number, appTypes: string[], button: object): Promise<boolean>;
}

export async function registerToolbarButtons(
  manager: ToolbarManager = PluginManager,
  icon: string = Image.resolveAssetSource(require('../assets/icon.png')).uri,
): Promise<void> {
  try {
    await manager.unregisterButton(LEGACY_SETUP_BUTTON_ID);
  } catch (error) {
    // A clean install has no legacy entry; do not prevent the active button.
    console.log(`[olaink] could not remove retired setup button: ${(error as Error).message}`);
  }

  // The host persists a side-button's label across an in-place plugin upgrade.
  // Remove the old delivery id too, so its visible name changes from SwapNote.
  try { await manager.unregisterButton(BUTTON_ID.share); } catch (error) {
    console.log(`[olaink] could not remove stale Share button: ${(error as Error).message}`);
  }

  try {
    await manager.registerButton(1, ['NOTE'], {
      id: BUTTON_ID.share,
      name: 'Ola Ink Share',
      icon,
      // No UI/runtime delivery loop is required; the listener launches Android.
      showType: 0,
    });
  } catch (error) {
    console.log(`[olaink] Ola Ink Share toolbar registration failed: ${(error as Error).message}`);
  }
}
