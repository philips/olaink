/** SwapNote toolbar wiring: setup view plus headless delivery entry point. */

import { Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import { BUTTON_ID } from './buttonIds.ts';

export function registerToolbarButtons(): void {
  const icon = Image.resolveAssetSource(require('../assets/icon.png')).uri;
  void PluginManager.registerButton(1, ['NOTE'], {
    id: BUTTON_ID.setup,
    name: 'SwapNote Setup',
    icon,
    showType: 1,
  });
  void PluginManager.registerButton(1, ['NOTE'], {
    id: BUTTON_ID.delivery,
    name: 'SwapNote',
    icon,
    showType: 0,
  });
}
