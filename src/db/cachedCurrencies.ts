import { getDb } from './instance';
import { blobKeys } from './keys';
import { readBlob } from './repository';
import { getCurrentScope } from './scope';
import type { Db } from './types';

// 离线币种兜底：HomeScreen 的 getCurrencies 依赖网络，失败时 Redux 的 currentCode 与
// currencies 列表都会停在初始值，新增交易表单随即没有币种、外币选择器也没有候选。
// currencies blob 由同步写入 `{ currentCode, currencies }`（见 models/currencies.ts 与
// syncBlobs.ts）；形状不匹配或读取失败一律降级，不伪造数据。

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// 只保留 UI 实际用到的字段并归一化类型：id 统一成字符串，code 必须非空，
// symbol/name 缺失时补空串或 code，避免界面渲染 undefined。
export type CachedCurrency = {
  id: string;
  type: string;
  attributes: {
    code: string;
    symbol: string;
    name: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type CachedCurrencies = {
  currentCode: string | null;
  currencies: CachedCurrency[];
};

const toCurrency = (value: unknown): CachedCurrency | null => {
  if (!isRecord(value) || !isRecord(value.attributes)) {
    return null;
  }
  const { id, type, attributes } = value;
  const normalizedId = typeof id === 'string' ? id : (typeof id === 'number' ? String(id) : '');
  const { code } = attributes;
  if (normalizedId === '' || typeof code !== 'string' || code === '') {
    return null;
  }
  return {
    ...value,
    id: normalizedId,
    type: typeof type === 'string' && type !== '' ? type : 'currencies',
    attributes: {
      ...attributes,
      code,
      symbol: typeof attributes.symbol === 'string' ? attributes.symbol : '',
      name: typeof attributes.name === 'string' ? attributes.name : code,
    },
  };
};

// 缓存缺失、形状不对、既无当前币种又无有效条目时返回 null：调用方据此保留现有 state。
export async function readCachedCurrencies(db: Db, scopeId: string): Promise<CachedCurrencies | null> {
  try {
    const blob = await readBlob<unknown>(db, scopeId, blobKeys.currencies());
    if (!isRecord(blob?.payload)) {
      return null;
    }
    const { currentCode, currencies } = blob.payload;
    const code = typeof currentCode === 'string' && currentCode !== '' ? currentCode : null;
    const list = Array.isArray(currencies)
      ? currencies
        .map(toCurrency)
        .filter((item): item is CachedCurrency => item !== null)
      : [];
    if (code === null && list.length === 0) {
      return null;
    }
    return { currentCode: code, currencies: list };
  } catch {
    return null;
  }
}

export async function readCachedCurrentCode(db: Db, scopeId: string): Promise<string | null> {
  const cached = await readCachedCurrencies(db, scopeId);
  return cached?.currentCode ?? null;
}

// 读取路径自己解析当前 scope：调用方（HomeScreen）只关心「有没有可用的缓存币种」。
export async function cachedCurrencies(): Promise<CachedCurrencies | null> {
  try {
    const db = getDb();
    const scopeId = await getCurrentScope(db);
    return scopeId ? await readCachedCurrencies(db, scopeId) : null;
  } catch {
    // DB 未初始化：按无缓存处理，联网后 getCurrencies 会正常回填。
    return null;
  }
}

export async function cachedCurrentCode(): Promise<string | null> {
  const cached = await cachedCurrencies();
  return cached?.currentCode ?? null;
}
