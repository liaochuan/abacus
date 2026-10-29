import * as SQLite from 'expo-sqlite';

import { SCHEMA_SQL } from './schema';
import type { Db } from './types';

// 薄适配层：把 expo-sqlite 的异步 API 映射到共享的 Db 接口（契约见计划索引）。
const wrap = (native: SQLite.SQLiteDatabase): Db => ({
  exec: async (sql) => {
    await native.execAsync(sql);
  },
  run: async (sql, params = []) => {
    await native.runAsync(sql, params as SQLite.SQLiteBindValue[]);
  },
  all: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => native.getAllAsync<T>(sql, params as SQLite.SQLiteBindValue[]),
  get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => native.getFirstAsync<T>(sql, params as SQLite.SQLiteBindValue[]),
  tx: async <T>(fn: () => Promise<T>): Promise<T> => {
    let result: T | undefined;
    await native.withTransactionAsync(async () => {
      result = await fn();
    });
    return result as T;
  },
});

export async function openDatabase(): Promise<Db> {
  const native = await SQLite.openDatabaseAsync('abacus.db');
  return wrap(native);
}

// v1：DDL 全部是 CREATE ... IF NOT EXISTS，可重复执行。版本升级逻辑在后续任务按需扩展。
export async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA_SQL);
}
