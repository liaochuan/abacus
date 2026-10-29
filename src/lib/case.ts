// Firefly 的原始响应是 snake_case，本地模型统一用 camelCase。
// 这个转换是纯函数、零依赖，刻意与 src/lib/common.ts 分开：
// common.ts 在模块加载时就会碰 React Native（Dimensions/Platform）与 i18n，
// 数据层（src/db）只需要转换函数，不应被迫加载 UI 运行时。

const snakeToCamel = (str: string): string => str.replace(/(_\w)/g, (match) => match[1].toUpperCase());

// 递归转换对象键：数组逐项处理，普通对象重建，其余值原样返回。
// 对已经是 camelCase 的输入幂等；只保留自有可枚举键（与 JSON 解析结果一致）。
export const convertKeysToCamelCase = (data: any): any => {
  if (Array.isArray(data)) {
    return data.map((item) => convertKeysToCamelCase(item));
  }
  if (typeof data === 'object' && data !== null) {
    const camelCaseData = {};
    Object.keys(data).forEach((key) => {
      if (Object.hasOwn(data, key)) {
        const camelKey = snakeToCamel(key);
        if (typeof data[key] === 'object' && data[key] !== null) {
          camelCaseData[camelKey] = convertKeysToCamelCase(data[key]);
        } else {
          camelCaseData[camelKey] = data[key];
        }
      }
    });

    return camelCaseData;
  }

  return data;
};
