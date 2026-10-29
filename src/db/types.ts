// 跨计划共享接口，见 docs/superpowers/plans/2026-10-26-offline-sync-index.md。不要改名。
export type Db = {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | null>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
};
