const { withGradleProperties } = require('expo/config-plugins');

// Expo 模板默认 `org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m`。
// release 构建会同时跑 Kotlin/KSP 编译、lint vitals 与并行 worker，512m metaspace
// 会导致 `OutOfMemoryError: Metaspace`（kspReleaseKotlin、lintVitalAnalyzeRelease）。
// 这里放宽到 4g 堆 + 1g metaspace，避免打包随机失败。
const JVM_ARGS_PROPERTY = 'org.gradle.jvmargs';
const JVM_ARGS_VALUE = '-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8';

function setJvmArgs(properties, value = JVM_ARGS_VALUE) {
  const existing = properties.find(
    (item) => item.type === 'property' && item.key === JVM_ARGS_PROPERTY,
  );

  if (existing) {
    // eslint-disable-next-line no-param-reassign
    existing.value = value;
  } else {
    properties.push({ type: 'property', key: JVM_ARGS_PROPERTY, value });
  }

  return properties;
}

module.exports = function withGradleMemory(config) {
  return withGradleProperties(config, (configWithProperties) => {
    // eslint-disable-next-line no-param-reassign
    configWithProperties.modResults = setJvmArgs(configWithProperties.modResults);

    return configWithProperties;
  });
};

// 供单元测试直接验证注入结果
module.exports.setJvmArgs = setJvmArgs;
