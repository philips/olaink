// Entry for building the snuxlib demo instead of Ola Ink (dev only):
//   OLAINK_PLUGIN_ENTRY=index.snuxdemo.js scripts/snplg-deploy.sh packages/plugin
// It keeps the toolbar button registration so the plugin can still be opened.
import { PluginManager } from 'sn-plugin-lib';
import { registerDemo } from 'snuxlib/demo/registerDemo';
import { name as appName } from './app.json';
import { registerToolbarButton } from './src/toolbar';

registerDemo(appName, () => PluginManager.closePluginView());
void PluginManager.init()
  .then(() => registerToolbarButton())
  .catch(error => console.log('[snuxlib-demo] initialization failed: ' + (error?.message || error)));
