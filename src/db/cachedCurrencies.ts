import { getDb } from './instance';
import { blobKeys } from './keys';
import { readBlob } from './repository';
import { getCurrentScope } from './scope';
import type { Db } from './types';

// 离线币种兜底：HomeScreen 的 getCurrencies 依赖网络，失败时 Redux 的 currentCode 会停在 ''，
// 新增交易表单随即因「没有币种」中止。currencies blob 由同步写入
// `{ currentCode, currencies }`（见 models/currencies.ts 与 syncBlobs.ts），形状不匹配或读取
// 失败一律返回 null：只补当前币种，不伪造币种列表。

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export async function readCachedCurrentCode(db: Db, scopeId: string): Promise<string | null> {
  try {
    const blob = await readBlob<unknown>(db, scopeId, blobKeys.currencies());
    if (!isRecord(blob?.payload)) {
      return null;
    }
    const { currentCode } = blob.payload;
    return typeof currentCode === 'string' && currentCode !== '' ? currentCode : null;
  } catch {
    return null;
  }
}

// 读取路径自己解析当前 scope：调用方（HomeScreen）只关心「有没有可用的缓存币种」。
export async function cachedCurrentCode(): Promise<string | null> {
  try {
    const db = getDb();
    const scopeId = await getCurrentScope(db);
    return scopeId ? await readCachedCurrentCode(db, scopeId) : null;
  } catch {
    // DB 未初始化：按无缓存处理，联网后 getCurrencies 会正常回填。
    return null;
  }
}
