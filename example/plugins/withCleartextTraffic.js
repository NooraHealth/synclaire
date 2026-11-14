const { withAndroidManifest } = require('@expo/config-plugins');

/** app.json `android.usesCleartextTraffic` is not applied by prebuild. Release needs it for http://10.0.2.2. */
module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, config => {
    const application = config.modResults.manifest.application?.[0];
    if (application) application.$['android:usesCleartextTraffic'] = 'true';
    return config;
  });
};
