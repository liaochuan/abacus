import {
  deleteScope,
  hasLocalData,
  hasLocalDataFromCounts,
} from '../repository';
import type { Db } from '../types';

// jest 环境没有真实 SQLite：deleteScope / hasLocalData 用记录 SQL 的假 Db 验证语句与绑定参数，
// hasLocalData 的判定规则另由纯函数 hasLocalDataFromCounts 验证。

type QueryCall = { sql: string; params: unknown[] };

const createRecordingDb = () => {
  const runLog: QueryCall[] = [];
  let txCount = 0;

  const db: Db = {
    exec: async () => {},
    run: async (sql: string, params: unknown[] = []) => {
      runLog.push({ sql, params });
    },
    all: async <T>(): Promise<T[]> => [],
    get: async <T>(): Promise<T | null> => null,
    tx: async <T>(fn: () => Promise<T>): Promise<T> => {
      txCount += 1;
      return fn();
    },
  };

  return { db, runLog, txCount: () => txCount };
};

const createCountDb = (counts: { blobs: number; transactions: number }) => {
  const getLog: QueryCall[] = [];

  const db: Db = {
    exec: async () => {},
    run: async () => {},
    all: async <T>(): Promise<T[]> => [],
    get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      getLog.push({ sql, params });
      if (/ FROM blobs /i.test(sql)) {
        return { count: counts.blobs } as unknown as T;
      }
      if (/ FROM transactions /i.test(sql)) {
        return { count: counts.transactions } as unknown as T;
      }
      throw new Error(`unexpected get sql: ${sql}`);
    },
    tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
  return { db, getLog };
};

test('deleteScope 在一个事务内清理该 scope 的五张表', async () => {
  const { db, runLog, txCount } = createRecordingDb();

  await deleteScope(db, 'scope1');

  expect(txCount()).toBe(1);
  expect(runLog.map((call) => call.sql)).toEqual([
    'DELETE FROM transactions WHERE scope_id = ?',
    'DELETE FROM blobs WHERE scope_id = ?',
    'DELETE FROM outbox WHERE scope_id = ?',
    'DELETE FROM notices WHERE scope_id = ?',
    'DELETE FROM meta WHERE scope_id = ?',
  ]);
});

test('deleteScope 的每条删除都按 scope_id 绑定参数', async () => {
  const { db, runLog } = createRecordingDb();

  await deleteScope(db, 'scope1');

  expect(runLog).toHaveLength(5);
  for (let i = 0; i < runLog.length; i += 1) {
    expect(runLog[i].sql).toContain('WHERE scope_id = ?');
    expect(runLog[i].params).toEqual(['scope1']);
  }
});

test('本地数据判定：任一表有数据即为 true', () => {
  expect(hasLocalDataFromCounts(0, 0)).toBe(false);
  expect(hasLocalDataFromCounts(1, 0)).toBe(true);
  expect(hasLocalDataFromCounts(0, 1)).toBe(true);
  expect(hasLocalDataFromCounts(3, 7)).toBe(true);
});

test('hasLocalData 汇总 blobs 与 transactions 的行数', async () => {
  expect(await hasLocalData(createCountDb({ blobs: 0, transactions: 0 }).db, 'scope1')).toBe(false);
  expect(await hasLocalData(createCountDb({ blobs: 2, transactions: 0 }).db, 'scope1')).toBe(true);
  expect(await hasLocalData(createCountDb({ blobs: 0, transactions: 5 }).db, 'scope1')).toBe(true);
});

test('hasLocalData 的两条 COUNT 都按 scope_id 绑定参数', async () => {
  const { db, getLog } = createCountDb({ blobs: 2, transactions: 3 });

  await hasLocalData(db, 'scope1');

  expect(getLog).toHaveLength(2);
  for (let i = 0; i < getLog.length; i += 1) {
    expect(getLog[i].sql).toContain('WHERE scope_id = ?');
    expect(getLog[i].params).toEqual(['scope1']);
  }
  expect(getLog.map((call) => call.sql.includes('FROM blobs'))).toContain(true);
  expect(getLog.map((call) => call.sql.includes('FROM transactions'))).toContain(true);
});
