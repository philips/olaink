import { AppRegistry, Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import App from './App';
import { name as appName } from './app.json';

const E0_REVISION = 'file-exchange-native-v11';

AppRegistry.registerComponent(appName, () => App);

void PluginManager.init()
  .then(async () => {
    await PluginManager.registerButton(1, ['NOTE'], {
      id: 9150,
      name: 'Ola Ink native client experiment',
      icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
      enable: true,
      showType: 1,
    });
    console.log(`[olaink-native-exp] initialized ${E0_REVISION}`);
  })
  .catch(error => console.log('[olaink-native-exp] initialization failed: ' + (error?.message || error)));
