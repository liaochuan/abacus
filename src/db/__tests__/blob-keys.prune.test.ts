import {
  getMeta,
  pruneBlobs,
  readBlob,
  selectKeysToPrune,
  setMeta,
  writeBlob,
} from '../repository';
import type { Db } from '../types';

test('只保留当前区间与最近 3 个区间组合', () => {
  const keys = [
    'categories:2026-01-01:2026-03-31:EUR',
    'budgets:2025-10-01:2025-12-31:EUR',
    'summary:2025-07-01:2025-09-30:EUR',
    'chart:accounts:2025-04-01:2025-06-30:EUR:asset',
    'chart:balance:2025-01-01:2025-03-31:EUR',
  ];
  const kept = selectKeysToPrune(keys, '2026-01-01:2026-03-31', 3);
  expect(kept).toEqual(['chart:balance:2025-01-01:2025-03-31:EUR']);
});

test('chart 键按第 3、4 段解析区间（前缀多一段）', () => {
  // chart:accounts 的区间在第 2、3 段（0-based），与非 chart 键错位一位。
  const keys = [
    'chart:balance:2025-01-01:2025-03-31:EUR',
    'categories:2025-01-01:2025-03-31:EUR',
  ];
  // 两个键解析出同一区间，keepRanges=0 时当前区间仍保留。
  expect(selectKeysToPrune(keys, '2025-01-01:2025-03-31', 0)).toEqual([]);
  // 当前区间换成别的，两组（同区间算一组）都不在保留前 0 组内 → 全删。
  expect(selectKeysToPrune(keys, '2026-01-01:2026-03-31', 0)).toEqual(keys);
});

test('豁免键永不删除', () => {
  const exempt = [
    'autocomplete:accounts',
    'autocomplete:tags',
    'piggy_banks',
    'bills',
    'currencies',
  ];
  expect(selectKeysToPrune(exempt, '2026-01-01:2026-03-31', 0)).toEqual([]);
});

test('区间按起始日期降序保留前 N 组，返回顺序跟随输入', () => {
  const keys = [
    'summary:2025-01-01:2025-03-31:EUR', // 第 4 组（最旧）→ 删
    'budgets:2025-10-01:2025-12-31:EUR', // 第 1 组 → 留
    'categories:2025-04-01:2025-06-30:EUR', // 第 3 组 → 留
    'summary:2025-07-01:2025-09-30:EUR', // 第 2 组 → 留
    'categories:2024-10-01:2024-12-31:EUR', // 第 5 组 → 删
  ];
  expect(selectKeysToPrune(keys, '2026-01-01:2026-03-31', 3)).toEqual([
    'summary:2025-01-01:2025-03-31:EUR',
    'categories:2024-10-01:2024-12-31:EUR',
  ]);
});

type FakeRow = { payload: string; fetchedAt: string };
type MetaRow = { value: string | null };

// 内存版 meta/blobs 表假对象：验证 SQL 形态与绑定参数（真实 DB 行为归 Detox）。
// 断言占位符数量与参数数量一致，防止把数据拼进 SQL 字符串。
const createFakeDb = () => {
  const blobs = new Map<string, FakeRow>();
  const meta = new Map<string, MetaRow>();
  const rowKey = (scopeId: string, key: string) => `${scopeId}|${key}`;
  const checkPlaceholders = (sql: string, params: unknown[]) => {
    const marks = sql.split('?').length - 1;
    if (marks !== params.length) {
      throw new Error(`placeholder/param mismatch (${marks} vs ${params.length}): ${sql}`);
    }
  };
  const db: Db = {
    exec: async () => {},
    run: async (sql, params = []) => {
      checkPlaceholders(sql, params);
      if (/^INSERT OR REPLACE INTO blobs/i.test(sql)) {
        const [scopeId, key, payload, fetchedAt] = params as [string, string, string, string];
        blobs.set(rowKey(scopeId, key), { payload, fetchedAt });
        return;
      }
      if (/^INSERT OR REPLACE INTO meta/i.test(sql)) {
        const [scopeId, key, value] = params as [string, string, string | null];
        meta.set(rowKey(scopeId, key), { value: value ?? null });
        return;
      }
      const deleteAll = /^DELETE FROM blobs WHERE scope_id = \?$/i.test(sql);
      const deleteKeep = /^DELETE FROM blobs WHERE scope_id = \? AND key NOT IN \(\?\)/i.test(sql);
      if (deleteAll || deleteKeep) {
        const [scopeId, ...keep] = params as [string, ...string[]];
        // NOT IN (?, ?, ...) 的占位符个数必须等于 keepKeys 个数
        if (deleteKeep) {
          const marks = (sql.match(/\?/g) ?? []).length;
          if (marks !== keep.length + 1) {
            throw new Error(`keep placeholders mismatch: ${sql}`);
          }
        }
        const prefix = `${scopeId}|`;
        [...blobs.keys()]
          .filter((rk) => rk.startsWith(prefix))
          .forEach((rk) => {
            const name = rk.slice(prefix.length);
            if (deleteAll || !keep.includes(name)) {
              blobs.delete(rk);
            }
          });
        return;
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    all: async () => [],
    get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      checkPlaceholders(sql, params);
      if (/FROM blobs WHERE scope_id = \? AND key = \?/i.test(sql)) {
        const [scopeId, key] = params as [string, string];
        const row = blobs.get(rowKey(scopeId, key));
        return (row ? { ...row } : null) as T;
      }
      if (/FROM meta WHERE scope_id = \? AND key = \?/i.test(sql)) {
        const [scopeId, key] = params as [string, string];
        const row = meta.get(rowKey(scopeId, key));
        return (row ? { ...row } : null) as T;
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
  return { db, blobs, meta };
};

test('writeBlob/readBlob 往返并带 fetchedAt；缺失返回 null', async () => {
  const { db } = createFakeDb();
  await expect(readBlob(db, 'scope1', 'currencies')).resolves.toBeNull();
  await writeBlob(db, 'scope1', 'currencies', { data: [{ id: 1 }] }, '2026-10-26T00:00:00.000Z');
  const row = await readBlob<{ data: { id: number }[] }>(db, 'scope1', 'currencies');
  expect(row).not.toBeNull();
  expect(row?.payload).toEqual({ data: [{ id: 1 }] });
  expect(row?.fetchedAt).toBe('2026-10-26T00:00:00.000Z');

  // 覆盖写同键不重复插行
  await writeBlob(db, 'scope1', 'currencies', { data: [] });
  const second = await readBlob<{ data: unknown[] }>(db, 'scope1', 'currencies');
  expect(second?.payload).toEqual({ data: [] });
  // 默认 fetchedAt 为 ISO 时间戳
  expect(second?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // 不同 scope 互相隔离
  await expect(readBlob(db, 'scope2', 'currencies')).resolves.toBeNull();
});

test('getMeta/setMeta 读写 meta 表，null 存 SQL NULL', async () => {
  const { db, meta } = createFakeDb();
  await expect(getMeta(db, 'scope1', 'last_synced_at')).resolves.toBeNull();
  await setMeta(db, 'scope1', 'last_synced_at', '2026-10-26T00:00:00.000Z');
  await expect(getMeta(db, 'scope1', 'last_synced_at')).resolves.toBe('2026-10-26T00:00:00.000Z');
  await setMeta(db, 'scope1', 'last_sync_error', null);
  expect(meta.get('scope1|last_sync_error')).toEqual({ value: null });
  await expect(getMeta(db, 'scope1', 'last_sync_error')).resolves.toBeNull();
  await setMeta(db, 'scope1', 'last_sync_error', 'timeout'); // 覆盖写
  await expect(getMeta(db, 'scope1', 'last_sync_error')).resolves.toBe('timeout');
  expect(meta.size).toBe(2);
});

test('pruneBlobs 删除不在 keepKeys 的行；空 keepKeys 清空该 scope', async () => {
  const { db, blobs } = createFakeDb();
  await writeBlob(db, 'scope1', 'keep:a', 1);
  await writeBlob(db, 'scope1', 'drop:b', 2);
  await writeBlob(db, 'scope2', 'other:c', 3);
  await pruneBlobs(db, 'scope1', ['keep:a']);
  expect([...blobs.keys()].sort()).toEqual(['scope1|keep:a', 'scope2|other:c']);
  await pruneBlobs(db, 'scope1', []);
  expect([...blobs.keys()]).toEqual(['scope2|other:c']);
});
