const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const DATA_EXTRACTION_RULES_FILE = 'data_extraction_rules.xml';
const DATA_EXTRACTION_RULES_SOURCE = path.join(
  __dirname,
  'android-res',
  'xml',
  DATA_EXTRACTION_RULES_FILE,
);

function removeNetworkSecurityConfig(androidManifest) {
  const newManifest = { ...androidManifest };

  newManifest.manifest.application[0].$['android:networkSecurityConfig'] = undefined;
  newManifest.manifest.application[0].$['android:usesCleartextTraffic'] = 'true';

  return newManifest;
}

// 注意：本插件在 app.config.js 中必须排在 `expo-secure-store` 之后。
// expo-secure-store 同样会设置 `android:dataExtractionRules`，而 expo config plugins
// 按顺序执行，后执行的 mod 会覆盖先前的值；此处必须最后写入以保证备份规则生效。
function setBackupConfig(androidManifest) {
  const newManifest = { ...androidManifest };
  const application = newManifest.manifest.application?.[0];

  if (application) {
    application.$ = application.$ || {};
    // 允许备份，但由 dataExtractionRules 明确排除云备份，仅保留换机直传
    application.$['android:allowBackup'] = 'true';
    application.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
  }

  return newManifest;
}

function copyDataExtractionRules(config) {
  const xmlDir = path.join(
    config.modRequest.platformProjectRoot,
    'app',
    'src',
    'main',
    'res',
    'xml',
  );

  fs.mkdirSync(xmlDir, { recursive: true });
  fs.copyFileSync(DATA_EXTRACTION_RULES_SOURCE, path.join(xmlDir, DATA_EXTRACTION_RULES_FILE));

  return config;
}

module.exports = function withAndroidPlugin(config) {
  const configWithManifest = withAndroidManifest(config, (configWithProps) => {
    const mainApplication = configWithProps?.modResults;

    if (mainApplication) {
    // eslint-disable-next-line no-param-reassign
      configWithProps.modResults = setBackupConfig(removeNetworkSecurityConfig(mainApplication));
    }

    return configWithProps;
  });

  return withDangerousMod(configWithManifest, ['android', copyDataExtractionRules]);
};
