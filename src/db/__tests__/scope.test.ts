import { getCurrentScope, scopeIdFor, setCurrentScope } from '../scope';
import { blobKeys } from '../keys';
import type { Db } from '../types';

test('scope 稳定且区分账号', () => {
  const a = scopeIdFor('https://ff.example.com/', 'a@x.com');
  expect(a).toMatch(/^[0-9a-f]{16}$/);
  expect(scopeIdFor('https://ff.example.com', 'a@x.com')).toBe(a); // 尾斜杠与协议大小写无关
  expect(scopeIdFor('https://ff.example.com', 'b@x.com')).not.toBe(a);
  expect(scopeIdFor('https://other.example.com', 'a@x.com')).not.toBe(a);
});

test('blob 键带全维度', () => {
  expect(blobKeys.accounts('2026-01-01', '2026-03-31', 'CNY', false)).toBe('accounts:2026-01-01:2026-03-31:CNY:asset');
  expect(blobKeys.accounts('2026-01-01', '2026-03-31', 'CNY', true)).toBe('accounts:2026-01-01:2026-03-31:CNY:all');
  expect(blobKeys.chartAccounts('a', 'b', 'EUR', true)).toBe('chart:accounts:a:b:EUR:all');
  expect(blobKeys.categories('a', 'b', 'EUR')).toBe('categories:a:b:EUR');
});

test('scopeIdFor 归一化：trim、小写、去尾部 /', () => {
  const a = scopeIdFor('https://ff.example.com', 'a@x.com');
  expect(scopeIdFor('  https://ff.example.com  ', 'a@x.com')).toBe(a);
  expect(scopeIdFor('HTTPS://ff.example.com', 'a@x.com')).toBe(a);
  expect(scopeIdFor('https://ff.example.com//', 'a@x.com')).toBe(a);
  expect(scopeIdFor('https://FF.example.com/', 'A@X.com')).toBe(a); // 主机与邮箱大小写同样无关
});

// 索引契约与 spec §7.3 键表：Task 3 的 selectKeysToPrune 按第 2、3 段解析区间，
// 且按 `autocomplete:*`、`piggy_banks`、`bills`、`currencies` 字面量豁免，键名必须逐字一致。
test('blobKeys 与索引契约逐项一致', () => {
  expect(blobKeys.budgets('a', 'b', 'EUR')).toBe('budgets:a:b:EUR');
  expect(blobKeys.summary('a', 'b', 'EUR')).toBe('summary:a:b:EUR');
  expect(blobKeys.chartAccounts('a', 'b', 'EUR', false)).toBe('chart:accounts:a:b:EUR:asset');
  expect(blobKeys.chartBalance('a', 'b', 'EUR')).toBe('chart:balance:a:b:EUR');
  expect(blobKeys.autocomplete('accounts')).toBe('autocomplete:accounts');
  expect(blobKeys.autocomplete('tags')).toBe('autocomplete:tags');
  expect(blobKeys.piggyBanks()).toBe('piggy_banks');
  expect(blobKeys.bills()).toBe('bills');
  expect(blobKeys.currencies()).toBe('currencies');
});

type FakeMetaDb = { db: Db; rows: Map<string, string | null> };

const rowKey = (scopeId: string, key: string) => `${scopeId}|${key}`;

// 内存版 meta 表假对象：只验证 SQL 语句形态与参数（纯逻辑层，真实 DB 行为归 Detox）。
const createFakeMetaDb = (): FakeMetaDb => {
  const rows = new Map<string, string | null>();
  const db: Db = {
    exec: async () => {},
    run: async (sql, params = []) => {
      if (!/INSERT OR REPLACE INTO meta/i.test(sql)) {
        throw new Error(`unexpected sql: ${sql}`);
      }
      const [scopeId, key, value] = params as [string, string, string | null];
      rows.set(rowKey(scopeId, key), value ?? null);
    },
    all: async () => [],
    get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      if (!/FROM meta WHERE scope_id = \? AND key = \?/i.test(sql)) {
        throw new Error(`unexpected sql: ${sql}`);
      }
      const [scopeId, key] = params as [string, string];
      if (!rows.has(rowKey(scopeId, key))) {
        return null;
      }
      return { value: rows.get(rowKey(scopeId, key)) } as T;
    },
    tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
  return { db, rows };
};

test('current_scope 读写 meta 表的 _global 行', async () => {
  const { db, rows } = createFakeMetaDb();
  await expect(getCurrentScope(db)).resolves.toBe(''); // 行不存在时返回空串
  await setCurrentScope(db, '0123456789abcdef');
  expect(rows.get(rowKey('_global', 'current_scope'))).toBe('0123456789abcdef');
  await expect(getCurrentScope(db)).resolves.toBe('0123456789abcdef');
  await setCurrentScope(db, 'fedcba9876543210'); // 覆盖写，不重复插行
  await expect(getCurrentScope(db)).resolves.toBe('fedcba9876543210');
  expect(rows.size).toBe(1);
});

test('getCurrentScope 对 NULL 值返回空串', async () => {
  const { db, rows } = createFakeMetaDb();
  rows.set(rowKey('_global', 'current_scope'), null);
  await expect(getCurrentScope(db)).resolves.toBe('');
});
