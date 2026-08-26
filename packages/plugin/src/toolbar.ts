/** Ola Ink Share toolbar wiring. */

import { Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import { BUTTON_ID } from './buttonIds.ts';

export interface ToolbarManager {
  registerButton(type: number, appTypes: string[], button: object): Promise<boolean>;
  setButtonState?(id: number, state: boolean): Promise<boolean>;
}

export async function registerToolbarButtons(
  manager: ToolbarManager = PluginManager,
  icon: string = Image.resolveAssetSource(require('../assets/icon.png')).uri,
): Promise<void> {
  // Headless plugin runtimes are stopped immediately after initialization.
  // Calling registerButton must therefore be the first native operation: an
  // awaited cleanup here defers registration until after the host has stopped
  // JavaScript, yielding an apparently successful install with no extension.
  try {
    await manager.registerButton(1, ['NOTE'], {
      id: BUTTON_ID.share,
      name: 'Ola Ink Share',
      icon,
      // Native PluginButton defaults enable to false. Explicitly request an
      // enabled sidebar extension rather than relying on a host default.
      enable: true,
      // A button press starts this headless runtime instead of mounting App.
      showType: 0,
    });
    await manager.setButtonState?.(BUTTON_ID.share, true);
    console.log('[olaink] Ola Ink Share sidebar button registered and enabled');
  } catch (error) {
    console.log(`[olaink] Ola Ink Share toolbar registration failed: ${(error as Error).message}`);
  }
}
