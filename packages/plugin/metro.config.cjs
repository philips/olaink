const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

/**
 * npm-workspaces layout: dependencies are hoisted to the repo root. Metro
 * searches the root node_modules and follows workspace symlinks when needed.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [repoRoot],
  nodeModulesPaths: [
    path.resolve(__dirname, 'node_modules'),
    path.resolve(repoRoot, 'node_modules'),
  ],
  resolver: {
    unstable_enableSymlinks: true,
    unstable_enablePackageExports: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
