const APP_CONFIG_PATH = '../../../app.config';

type PluginEntry = string | [string, Record<string, any>];

const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=abacus.fireflyiii.android.liaocl';

const originalAppVariant = process.env.APP_VARIANT;

function loadConfig(): any {
  let loaded: any;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    loaded = require(APP_CONFIG_PATH).default;
  });
  return loaded;
}

function findPlugin(config: any, pluginName: string): PluginEntry | undefined {
  return (config.plugins as PluginEntry[]).find((entry) => (
    Array.isArray(entry) ? entry[0] === pluginName : entry === pluginName
  ));
}

function buildPropertiesOptions(config: any): Record<string, any> {
  const entry = findPlugin(config, 'expo-build-properties');
  expect(Array.isArray(entry)).toBe(true);
  return (entry as [string, Record<string, any>])[1];
}

afterEach(() => {
  if (originalAppVariant === undefined) {
    delete process.env.APP_VARIANT;
  } else {
    process.env.APP_VARIANT = originalAppVariant;
  }
});

test('默认构建的 Android 发布配置', () => {
  delete process.env.APP_VARIANT;

  const config = loadConfig();

  expect(config.android.package).toBe('abacus.fireflyiii.android.liaocl');
  expect(config.android.playStoreUrl).toBe(PLAY_STORE_URL);
  // minSdkVersion 必须通过 expo-build-properties 生效，顶层字段会被 prebuild 忽略
  expect(config.android.minSdkVersion).toBeUndefined();
  expect(buildPropertiesOptions(config).android.minSdkVersion).toBe(31);
});

test('上架包关闭 OTA 并使用自有签名插件', () => {
  delete process.env.APP_VARIANT;

  const config = loadConfig();

  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
  expect(config.extra?.eas).toBeUndefined();
  expect(findPlugin(config, './plugins/withReleaseSigning')).toBeDefined();
  expect(findPlugin(config, './plugins/withGradleMemory')).toBeDefined();
});

test('development 变体的 Android 发布配置', () => {
  process.env.APP_VARIANT = 'development';

  const config = loadConfig();

  expect(config.android.package).toBe('abacus.fireflyiii.android.liaocl.dev');
  expect(config.android.playStoreUrl).toBe(PLAY_STORE_URL);
  expect(buildPropertiesOptions(config).android.minSdkVersion).toBe(31);
});
