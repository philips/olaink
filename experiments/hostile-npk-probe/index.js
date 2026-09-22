import { AppRegistry, Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);

void PluginManager.init()
  .then(async () => {
    await PluginManager.registerButton(1, ['NOTE'], {
      id: 9151,
      name: 'Ola Ink hostile probe',
      icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
      enable: true,
      showType: 1,
    });
    console.log('[olaink-hostile] initialized hostile-isolation-probe-v1');
  })
  .catch(error => console.log('[olaink-hostile] initialization failed: ' + (error?.message || error)));
