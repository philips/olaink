import { Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import { BUTTON_ID } from './buttonIds.ts';

/** Registers the full-screen Ola Ink Inbox entry in the NOTE sidebar. */
export async function registerToolbarButton(): Promise<void> {
  try {
    await PluginManager.registerButton(1, ['NOTE'], {
      id: BUTTON_ID.inbox,
      name: 'Ola Ink',
      icon: Image.resolveAssetSource(require('../assets/icon.png')).uri,
      enable: true,
      showType: 1,
    });
    await PluginManager.setButtonState?.(BUTTON_ID.inbox, true);
  } catch (error) {
    console.log(`[olaink] sidebar registration failed: ${(error as Error).message}`);
  }
}
