/** Ola Ink Share toolbar wiring. */

import { Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import { BUTTON_ID } from './buttonIds.ts';

export interface ToolbarManager {
  unregisterButton(id: number): Promise<boolean>;
  registerButton(type: number, appTypes: string[], button: object): Promise<boolean>;
}

export async function registerToolbarButtons(
  manager: ToolbarManager = PluginManager,
  icon: string = Image.resolveAssetSource(require('../assets/icon.png')).uri,
): Promise<void> {
  // The host persists a side-button label across an in-place plugin upgrade.
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
