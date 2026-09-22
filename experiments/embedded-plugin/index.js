import { AppRegistry, Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);

void PluginManager.init()
  .then(async () => {
    await PluginManager.registerButton(1, ['NOTE'], {
      id: 9102,
      name: 'Ola Ink native probe',
      icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
      enable: true,
      showType: 1,
    });
    console.log('[olaink-probe] initialized with native package metadata');
  })
  .catch(error => console.log('[olaink-probe] initialization failed: ' + (error?.message || error)));
