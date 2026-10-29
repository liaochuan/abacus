import type { Db } from './types';

// 进程级数据库句柄：AppBootstrap 在 openDatabase + migrate 成功后 setDb，
// 后续任务通过 getDb 取用，不再各自打开连接。setDb 前调用 getDb 抛错。
let db: Db | null = null;

export function setDb(next: Db): void {
  db = next;
}

export function getDb(): Db {
  if (db === null) {
    throw new Error('database not initialised');
  }
  return db;
}
