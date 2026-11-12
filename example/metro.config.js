// Resolves `synclaire` to the library source one level up. Bare imports made from library files
// (react, expo-sqlite, ...) are resolved from this app so there is a single copy of each.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const libraryRoot = path.resolve(projectRoot, '..');
const escape = s => s.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [libraryRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.extraNodeModules = { synclaire: libraryRoot };
config.resolver.blockList = [
  new RegExp(`^${escape(libraryRoot)}/node_modules/.*`),
  new RegExp(`^${escape(projectRoot)}/(ios|android)/.*`),
];

const isBare = name => !name.startsWith('.') && !path.isAbsolute(name);
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromLibrary = !context.originModulePath.startsWith(projectRoot + path.sep);
  if (fromLibrary && isBare(moduleName) && moduleName !== 'synclaire' && !moduleName.startsWith('synclaire/')) {
    return context.resolveRequest(
      { ...context, originModulePath: path.join(projectRoot, 'App.tsx') },
      moduleName,
      platform,
    );
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
