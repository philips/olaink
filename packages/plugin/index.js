/**
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager} from 'sn-plugin-lib';
import {startSession} from './src/headless';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

const icon = Image.resolveAssetSource(require('./assets/icon.png')).uri;

// Setup: fullscreen status/config UI. Closing it stops the runtime (host
// calls stopPlugin on view close), so live sessions use the button below.
PluginManager.registerButton(1, ['NOTE'], {
  id: 101,
  name: 'WRTN Setup',
  icon,
  showType: 1,
});

// Session: headless. Tap in a note, then just draw — strokes flow while
// the note stays open. This is the long-running entry point.
PluginManager.registerButton(1, ['NOTE'], {
  id: 102,
  name: 'WRTN',
  icon,
  showType: 0,
});

// Start the session as soon as the runtime is up (idempotent). If the
// runtime was booted by the headless button, no view ever mounts and this
// is the only thing that runs.
startSession();
