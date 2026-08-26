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

PluginManager.init();

// The headless toolbar listener only launches the Android companion. It has
// no account, transport, crypto, or background receive lifecycle.
void registerToolbarButtons();
registerShareButtonListener();
