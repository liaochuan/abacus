import { blobKeys } from './keys';
import { readBlob } from './repository';
import type { Db } from './types';

// 离线 autocomplete 数据源：blob 由同步任务写入 `autocomplete:<kind>`（键定义见 keys.ts），
// 这里只负责读缓存 + 本地过滤，调用方在离线时不发网络请求。

export type AutocompleteKind = 'accounts' | 'categories' | 'budgets' | 'bills' | 'tags';

export type AutocompleteOption = {
  id: string;
  name: string;
  // 同步缓存带实体类型（账户类型过滤需要）；旧缓存可能没有。
  type?: string;
  // 账户缓存额外带币种，离线选中后才能沿用账户币种而不是全局当前币种。
  currencyCode?: string;
  currencySymbol?: string;
};

// 可选文本字段：空串、非字符串一律视为缺失，避免把脏值写进选项。
const optionalText = (value: unknown): string | undefined => (
  typeof value === 'string' && value !== '' ? value : undefined
);

// 缓存的规范形状是 { id, name }[]；历史数据可能是 string[] 或 { name }[]。
// 统一归一化：缺 id 补空串，缺 name 的条目视为损坏数据丢弃。
const toOption = (item: unknown): AutocompleteOption | null => {
  if (typeof item === 'string') {
    return item === '' ? null : { id: '', name: item };
  }
  if (item === null || typeof item !== 'object') {
    return null;
  }
  const {
    id, name, type, currencyCode, currencySymbol,
  } = item as {
    id?: unknown;
    name?: unknown;
    type?: unknown;
    currencyCode?: unknown;
    currencySymbol?: unknown;
  };
  if (typeof name !== 'string' || name === '') {
    return null;
  }
  // 旧缓存没有币种字段：保持原有形状，不补空串。
  const normalizedCurrencyCode = optionalText(currencyCode);
  const normalizedCurrencySymbol = optionalText(currencySymbol);
  return {
    id: typeof id === 'string' ? id : '',
    name,
    type: typeof type === 'string' && type !== '' ? type : undefined,
    ...(normalizedCurrencyCode !== undefined ? { currencyCode: normalizedCurrencyCode } : {}),
    ...(normalizedCurrencySymbol !== undefined ? { currencySymbol: normalizedCurrencySymbol } : {}),
  };
};

const toOptions = (payload: unknown): AutocompleteOption[] => {
  if (!Array.isArray(payload)) {
    return [];
  }
  const options: AutocompleteOption[] = [];
  for (let i = 0; i < payload.length; i += 1) {
    const option = toOption(payload[i]);
    if (option !== null) {
      options.push(option);
    }
  }
  return options;
};

// 缓存缺失、读取失败、JSON 损坏、形状不对一律收敛为空数组，离线 UI 据此展示空态。
export async function readAutocomplete(
  db: Db,
  scopeId: string,
  kind: AutocompleteKind,
): Promise<AutocompleteOption[]> {
  try {
    const blob = await readBlob<unknown>(db, scopeId, blobKeys.autocomplete(kind));
    return toOptions(blob?.payload);
  } catch {
    return [];
  }
}

// 大小写不敏感的子串匹配；空查询直接返回前 limit 条；结果保持输入顺序（不做匹配度排序）。
export function filterAutocomplete(
  items: AutocompleteOption[],
  text: string,
  limit = 20,
): AutocompleteOption[] {
  if (limit <= 0) {
    return [];
  }
  const needle = text.trim().toLowerCase();
  const result: AutocompleteOption[] = [];
  for (let i = 0; i < items.length && result.length < limit; i += 1) {
    const item = items[i];
    if (needle === '' || item.name.toLowerCase().includes(needle)) {
      result.push(item);
    }
  }
  return result;
}

// 账户类型过滤：与线上 `types=` 参数同一套规则。旧缓存没有 type 时保留，
// 宁可多给候选也不能把账户从离线列表里整类抹掉。
export function filterAutocompleteByTypes(
  items: AutocompleteOption[],
  allowedTypes: string[],
): AutocompleteOption[] {
  if (allowedTypes.length === 0) {
    return items;
  }
  const allowed = new Set(allowedTypes);
  return items.filter((item) => item.type === undefined || allowed.has(item.type));
}
