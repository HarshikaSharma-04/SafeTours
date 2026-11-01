const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// expo-sqlite's web build ships a WebAssembly file; without this `npm run web` cannot bundle at all.
config.resolver.assetExts.push('wasm');

module.exports = config;
