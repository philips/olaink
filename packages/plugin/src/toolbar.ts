/** SwapNote toolbar wiring: headless delivery entry point. */

import { Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import { BUTTON_ID } from './buttonIds.ts';

export function registerToolbarButtons(): void {
  const icon = Image.resolveAssetSource(require('../assets/icon.png')).uri;
  void PluginManager.registerButton(1, ['NOTE'], {
    id: BUTTON_ID.delivery,
    name: 'SwapNote',
    icon,
    showType: 0,
  });
}
