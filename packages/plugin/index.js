import { AppRegistry } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import App from './App';
import { name as appName } from './app.json';
import { registerToolbarButton } from './src/toolbar';

AppRegistry.registerComponent(appName, () => App);
void PluginManager.init()
  .then(() => registerToolbarButton())
  .catch(error => console.log('[olaink] initialization failed: ' + (error?.message || error)));
