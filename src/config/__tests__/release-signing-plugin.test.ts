// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { addReleaseSigningConfig } = require('../../../plugins/withReleaseSigning');

const TEMPLATE = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
`;

function releaseBuildType(contents: string): string {
  const start = contents.indexOf('release {', contents.indexOf('buildTypes'));
  return contents.slice(start, contents.indexOf('minifyEnabled false', start));
}

function releaseSigningConfig(contents: string): string {
  const start = contents.indexOf('signingConfigs {');
  return contents.slice(start, contents.indexOf('debug {', start));
}

test('release buildType 改用 release 签名配置，debug 保持不变', () => {
  const result = addReleaseSigningConfig(TEMPLATE);

  expect(releaseBuildType(result)).toContain('signingConfig signingConfigs.release');
  expect(result).toMatch(/debug \{\r?\n\s+signingConfig signingConfigs\.debug/);
});

test('release 签名从环境变量读取 keystore，源码里不留密钥材料', () => {
  const result = addReleaseSigningConfig(TEMPLATE);

  const signing = releaseSigningConfig(result);

  expect(signing).toContain("System.getenv('ABACUS_UPLOAD_STORE_FILE')");
  expect(signing).toContain("System.getenv('ABACUS_UPLOAD_STORE_PASSWORD')");
  expect(signing).toContain("System.getenv('ABACUS_UPLOAD_KEY_ALIAS')");
  expect(signing).toContain("System.getenv('ABACUS_UPLOAD_KEY_PASSWORD')");
  expect(signing).not.toMatch(/storePassword\s+['"]/);
  expect(signing).not.toMatch(/keyPassword\s+['"]/);
});

test('重复执行注入具有幂等性', () => {
  const once = addReleaseSigningConfig(TEMPLATE);
  const twice = addReleaseSigningConfig(once);

  expect(twice).toBe(once);
  expect(once.match(/ABACUS_UPLOAD_STORE_FILE/g)).toHaveLength(1);
});
