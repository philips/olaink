/** SwapNote toolbar wiring: removes the retired setup entry, then adds inbox. */

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
    console.log(`[wrtn] could not remove retired setup button: ${(error as Error).message}`);
  }

  try {
    await manager.registerButton(1, ['NOTE'], {
      id: BUTTON_ID.delivery,
      name: 'SwapNote',
      icon,
      showType: 0,
    });
  } catch (error) {
    console.log(`[wrtn] SwapNote toolbar registration failed: ${(error as Error).message}`);
  }
}
