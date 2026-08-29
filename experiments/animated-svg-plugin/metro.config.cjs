const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [repoRoot],
  resolver: {
    nodeModulesPaths: [path.join(repoRoot, 'node_modules')],
    unstable_enableSymlinks: true,
    unstable_enablePackageExports: true,
  },
});
