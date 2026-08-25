const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

/**
 * npm-workspaces layout: deps are hoisted to the repo root and workspace
 * packages (@olaink/protocol) are symlinks. Metro needs to be told to follow
 * symlinks and search the root node_modules.
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
