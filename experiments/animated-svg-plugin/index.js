import { AppRegistry, Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);

void PluginManager.init()
  .then(async () => {
    await PluginManager.registerButton(1, ['NOTE'], {
      id: 9102,
      name: 'Ola Ink animated SVG probe',
      icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
      enable: true,
      showType: 1,
    });
    console.log('[olaink-svg-probe] initialized with native Canvas SVG-scene package');
  })
  .catch(error => console.log('[olaink-svg-probe] initialization failed: ' + (error?.message || error)));
