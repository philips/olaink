/**
 * @format
 */

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager} from 'sn-plugin-lib';
import {registerToolbarButtons} from './src/toolbar';
import {registerShareButtonListener} from './src/shareButton';
import {BUILD_STAMP} from './src/buildStamp';

// Top-level (synchronous) so it proves which bundle is actually running.
console.log('[olaink] bundle stamp ' + BUILD_STAMP.git + ' ' + BUILD_STAMP.builtAt);

AppRegistry.registerComponent(appName, () => App);

// init() performs native bridge installation synchronously before returning
// its resolved promise. Do not await it: the host stops a headless runtime
// after initialization, before a promise continuation can register a button.
void PluginManager.init().catch(error => console.log('[olaink] PluginManager init failed: ' + (error?.message || error)));
void registerToolbarButtons();
registerShareButtonListener();
console.log('[olaink] toolbar registration dispatched');
