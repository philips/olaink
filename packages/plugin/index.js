/**
 * @format
 */

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager} from 'sn-plugin-lib';
import {registerToolbarButtons} from './src/toolbar';
import {startSwapNote} from './src/headless';
import {registerPluginManagerConfigButton} from './src/configButton';
import {registerInboxButtonListener} from './src/inboxButton';
import {BUILD_STAMP} from './src/buildStamp';
import {logSecureRandomProbe} from './src/crypto/secureRandom';

// Top-level (synchronous) so it proves which bundle is actually running.
console.log('[wrtn] bundle stamp ' + BUILD_STAMP.git + ' ' + BUILD_STAMP.builtAt);
logSecureRandomProbe();

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

// Plugin Manager configuration entry: native button registration must happen
// before its listener (enforced inside configButton.ts).
registerPluginManagerConfigButton();

// Headless delivery toolbar entry point and its full-screen inbox view.
void registerToolbarButtons();
registerInboxButtonListener();

// Start delivery as soon as the runtime is up. A headless-button launch has
// no mounted view, so this is the only entry point.
startSwapNote();
