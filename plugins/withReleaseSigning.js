const { withAppBuildGradle } = require('expo/config-plugins');

// 上架包使用自有 keystore 签名。
// 路径与密码一律从环境变量读取，仓库里不保存任何密钥材料：
//   ABACUS_UPLOAD_STORE_FILE / ABACUS_UPLOAD_STORE_PASSWORD
//   ABACUS_UPLOAD_KEY_ALIAS  / ABACUS_UPLOAD_KEY_PASSWORD
// 缺少这些变量时 `assembleRelease` / `bundleRelease` 会以
// “Keystore file not set for signing config release” 失败，debug 构建不受影响。
const RELEASE_SIGNING_CONFIG = `        release {
            def releaseStoreFile = System.getenv('ABACUS_UPLOAD_STORE_FILE')
            if (releaseStoreFile != null && !releaseStoreFile.isEmpty()) {
                storeFile file(releaseStoreFile)
            }
            storePassword System.getenv('ABACUS_UPLOAD_STORE_PASSWORD')
            keyAlias System.getenv('ABACUS_UPLOAD_KEY_ALIAS')
            keyPassword System.getenv('ABACUS_UPLOAD_KEY_PASSWORD')
        }
`;

function addReleaseSigningConfig(contents) {
  if (contents.includes('signingConfigs.release')) {
    return contents;
  }

  // 1. 在 signingConfigs { 后插入 release 签名配置
  let result = contents.replace(
    /(signingConfigs \{\r?\n)/,
    (match) => `${match}${RELEASE_SIGNING_CONFIG}`,
  );

  // 2. 让 release buildType 使用它，而不是模板默认的 debug keystore
  result = result.replace(
    /(release \{[^}]*?signingConfig )signingConfigs\.debug/,
    '$1signingConfigs.release',
  );

  return result;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (configWithGradle) => {
    // eslint-disable-next-line no-param-reassign
    configWithGradle.modResults.contents = addReleaseSigningConfig(
      configWithGradle.modResults.contents,
    );

    return configWithGradle;
  });
};

// 供单元测试直接验证注入结果
module.exports.addReleaseSigningConfig = addReleaseSigningConfig;
