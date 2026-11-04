// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { setJvmArgs } = require('../../../plugins/withGradleMemory');

type GradleProperty = { type: string; key: string; value: string };

function property(key: string, value: string): GradleProperty {
  return { type: 'property', key, value };
}

test('覆盖 Expo 模板默认的 512m metaspace', () => {
  const properties = [
    property('org.gradle.jvmargs', '-Xmx2048m -XX:MaxMetaspaceSize=512m'),
    property('android.useAndroidX', 'true'),
  ];

  const result = setJvmArgs(properties);

  expect(result.filter((item) => item.key === 'org.gradle.jvmargs')).toEqual([
    property('org.gradle.jvmargs', '-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8'),
  ]);
  expect(result).toContainEqual(property('android.useAndroidX', 'true'));
});

test('缺少该属性时追加而不是报错', () => {
  const result = setJvmArgs([property('android.useAndroidX', 'true')]);

  expect(result).toContainEqual(
    property('org.gradle.jvmargs', '-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8'),
  );
  expect(result).toHaveLength(2);
});

test('重复执行不会产生重复属性', () => {
  const once = setJvmArgs([]);
  const twice = setJvmArgs(once);

  expect(twice.filter((item) => item.key === 'org.gradle.jvmargs')).toHaveLength(1);
});
