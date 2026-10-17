import React from 'react';
import { AppRegistry } from 'react-native';
import DemoApp from './DemoApp';

/**
 * Registers the demo as the plugin's root component. Call it from a plugin's
 * entry file instead of registering the real App:
 *
 *   import { PluginManager } from 'sn-plugin-lib';
 *   import { registerDemo } from 'snuxlib/demo/registerDemo';
 *   registerDemo('<name from app.json>', () => PluginManager.closePluginView());
 */
export function registerDemo(appName: string, onClose: () => void) {
  AppRegistry.registerComponent(appName, () => () => <DemoApp onClose={onClose} />);
}
