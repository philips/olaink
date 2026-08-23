/**
 * @format
 */

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager} from 'sn-plugin-lib';
import {registerToolbarButtons} from './src/toolbar';
import {startSession} from './src/headless';
import {BUILD_STAMP} from './src/buildStamp';

// Top-level (synchronous) so it proves which bundle is actually running.
console.log('[wrtn] bundle stamp ' + BUILD_STAMP.git + ' ' + BUILD_STAMP.builtAt);

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

// Toolbar buttons (setup view, headless session entry, headless pull) — see
// src/toolbar.ts.
registerToolbarButtons();

// Start the session as soon as the runtime is up (idempotent). If the
// runtime was booted by a headless button, no view ever mounts and this is
// the only thing that runs.
startSession();
