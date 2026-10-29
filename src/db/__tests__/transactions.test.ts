import {
  buildTransactionWhere,
  deleteLocalTransaction,
  getTransaction,
  groupUpdatedAt,
  listTransactions,
  occurredAtOf,
  reconcileDeletions,
  upsertServerTransactions,
} from '../repository';
import type { Db } from '../types';

// ---- brief 的 TDD 测试（Step 1；type 断言见下注） ----

test('结构化筛选生成 SQL 与参数', () => {
  const { sql, params } = buildTransactionWhere({
    start: '2026-01-01', end: '2026-03-31', type: 'withdrawal',
    account: 'Cash', categoryId: '7', text: 'coffee',
  });
  expect(sql).toContain('occurred_at >= ?');
  // brief 写的是 toContain('type = ?')，但 type 过滤的实际 SQL 是
  // json_extract(payload, '$.attributes.transactions[0].type') = ?，
  // 两者无法同时成立（JSON 路径里 type 后跟引号，不会出现裸 "type = ?"）。
  // 这里断言真实 SQL 形态；参数顺序逐字保留 brief 的期望。
  expect(sql).toContain("json_extract(payload, '$.attributes.transactions[0].type') = ?");
  expect(sql).toContain('json_extract(payload');
  expect(params).toEqual(['2026-01-01', '2026-03-31', 'withdrawal', '%Cash%', '7', '%coffee%']);
});

test('hasAnyCategory=false 时不带分类 id', () => {
  const { sql, params } = buildTransactionWhere({ hasAnyCategory: false });
  expect(sql).toContain("json_extract(payload, '$.attributes.transactions[0].categoryId') = ''");
  expect(params).toEqual([]);
});

test('币种过滤按 split 的 currencyCode，参数在 type 之后、account 之前', () => {
  const { sql, params } = buildTransactionWhere({
    type: 'withdrawal',
    currencyCode: 'CNY',
    account: 'Cash',
  });
  expect(sql).toContain("json_extract(payload, '$.attributes.transactions[0].currencyCode') = ?");
  expect(params).toEqual(['withdrawal', 'CNY', '%Cash%']);
});

test('组级 updated_at 取 split 最大值', () => {
  expect(groupUpdatedAt({ attributes: { transactions: [
    { updatedAt: '2026-01-01T00:00:00+00:00' },
    { updatedAt: '2026-02-01T00:00:00+00:00' },
  ] } } as any)).toBe('2026-02-01T00:00:00+00:00');
  expect(groupUpdatedAt({ attributes: { transactions: [] } } as any)).toBeNull();
});

// ---- 纯函数补充断言 ----

test('空筛选只保留 scope_id 占位', () => {
  expect(buildTransactionWhere({}).sql).toBe(' WHERE scope_id = ?');
  expect(buildTransactionWhere({}).params).toEqual([]);
});

test('account 同时匹配 sourceName 与 destinationName，且只绑定一次', () => {
  const { sql, params } = buildTransactionWhere({ account: 'Cash' });
  expect(sql).toContain('sourceName');
  expect(sql).toContain('destinationName');
  expect(params).toEqual(['%Cash%']);
});

test('occurredAtOf 取首笔 split 的 date', () => {
  expect(occurredAtOf({ attributes: { transactions: [
    { date: '2026-10-01T10:00:00Z' },
    { date: '2026-10-02T10:00:00Z' },
  ] } } as any)).toBe('2026-10-01T10:00:00Z');
});

// ---- 内存版 transactions/notices 假 DB：验证 SQL 形态与绑定参数，并模拟真实行为 ----

type TxRow = {
  scope_id: string;
  id: string;
  payload: string;
  occurred_at: string;
  server_updated_at: string | null;
  dirty: number;
};

type NoticeRow = {
  scope_id: string;
  id: string;
  kind: string;
  entity_id: string;
  local_payload: string | null;
  server_payload: string | null;
  detected_at: string;
  acknowledged_at: string | null;
};

const createFakeDb = () => {
  const transactions = new Map<string, TxRow>();
  const notices: NoticeRow[] = [];
  const runLog: Array<{ sql: string; params: unknown[] }> = [];
  let txCount = 0;
  const rowKey = (scopeId: string, id: string) => `${scopeId}|${id}`;

  const checkPlaceholders = (sql: string, params: unknown[]) => {
    const marks = sql.split('?').length - 1;
    if (marks !== params.length) {
      throw new Error(`placeholder/param mismatch (${marks} vs ${params.length}): ${sql}`);
    }
  };

  const db: Db = {
    exec: async () => {},
    run: async (sql, params = []) => {
      runLog.push({ sql, params });
      checkPlaceholders(sql, params);
      if (/^INSERT INTO transactions/i.test(sql)) {
        const [scopeId, id, payload, occurredAt, serverUpdatedAt] = params as [string, string, string, string, string | null];
        transactions.set(rowKey(scopeId, id), {
          scope_id: scopeId,
          id,
          payload,
          occurred_at: occurredAt,
          server_updated_at: serverUpdatedAt,
          dirty: 0,
        });
        return;
      }
      if (/^INSERT INTO notices/i.test(sql)) {
        const [scopeId, id, entityId, serverPayload, detectedAt] = params as [string, string, string, string, string];
        notices.push({
          scope_id: scopeId,
          id,
          kind: 'server_deletion',
          entity_id: entityId,
          local_payload: null,
          server_payload: serverPayload,
          detected_at: detectedAt,
          acknowledged_at: null,
        });
        return;
      }
      if (/^DELETE FROM transactions/i.test(sql)) {
        const [scopeId, id] = params as [string, string];
        if (/AND dirty = 0/i.test(sql)) {
          const row = transactions.get(rowKey(scopeId, id));
          if (row && row.dirty === 0) {
            transactions.delete(rowKey(scopeId, id));
          }
        } else {
          transactions.delete(rowKey(scopeId, id));
        }
        return;
      }
      throw new Error(`unexpected run sql: ${sql}`);
    },
    all: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      checkPlaceholders(sql, params);
      if (/ORDER BY occurred_at DESC/i.test(sql)) {
        const [scopeId, ...rest] = params as [string, ...unknown[]];
        const limit = rest[rest.length - 2] as number;
        const offset = rest[rest.length - 1] as number;
        const rows = [...transactions.values()]
          .filter((r) => r.scope_id === scopeId)
          .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
          .slice(offset, offset + limit);
        return rows as unknown as T[];
      }
      if (/SELECT id, payload FROM transactions/i.test(sql)) {
        const [scopeId] = params as [string];
        const rows = [...transactions.values()]
          .filter((r) => r.scope_id === scopeId && r.dirty === 0)
          .map((r) => ({ id: r.id, payload: r.payload }));
        return rows as unknown as T[];
      }
      throw new Error(`unexpected all sql: ${sql}`);
    },
    get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      checkPlaceholders(sql, params);
      if (/SELECT dirty FROM transactions/i.test(sql)) {
        const [scopeId, id] = params as [string, string];
        const row = transactions.get(rowKey(scopeId, id));
        return (row ? { dirty: row.dirty } : null) as unknown as T;
      }
      if (/SELECT \* FROM transactions WHERE scope_id = \? AND id = \?/i.test(sql)) {
        const [scopeId, id] = params as [string, string];
        const row = transactions.get(rowKey(scopeId, id));
        return (row ? { ...row } : null) as unknown as T;
      }
      throw new Error(`unexpected get sql: ${sql}`);
    },
    tx: async <T>(fn: () => Promise<T>): Promise<T> => {
      txCount += 1;
      return fn();
    },
  };

  return { db, transactions, notices, runLog, rowKey, txCount: () => txCount };
};

const seed = (
  transactions: Map<string, TxRow>,
  rowKey: (scopeId: string, id: string) => string,
  scopeId: string,
  id: string,
  occurredAt: string,
  dirty = 0,
) => {
  transactions.set(rowKey(scopeId, id), {
    scope_id: scopeId,
    id,
    payload: JSON.stringify({ id, attributes: { transactions: [] } }),
    occurred_at: occurredAt,
    server_updated_at: null,
    dirty,
  });
};

test('listTransactions 按 occurred_at 降序、分页、按 scope 隔离，并把行映射为记录', async () => {
  const { db, transactions, rowKey } = createFakeDb();
  seed(transactions, rowKey, 'scope1', 'a', '2026-01-01');
  seed(transactions, rowKey, 'scope1', 'b', '2026-03-01');
  seed(transactions, rowKey, 'scope1', 'c', '2026-02-01');
  seed(transactions, rowKey, 'scope2', 'd', '2026-04-01');

  const rows = await listTransactions(db, 'scope1', { limit: 2, offset: 1 });
  // 降序：b(03) c(02) a(01) → offset 1 取 2 条 → c, a
  expect(rows.map((r) => r.id)).toEqual(['c', 'a']);
  expect(rows.every((r) => r.id !== 'd')).toBe(true);
  expect(rows[0].occurredAt).toBe('2026-02-01');
  expect(rows[0].dirty).toBe(false);
  expect(rows[0].payload).toEqual({ id: 'c', attributes: { transactions: [] } });
});

test('getTransaction 单行读取、缺失返回 null、按 scope 隔离', async () => {
  const { db, transactions, rowKey } = createFakeDb();
  seed(transactions, rowKey, 'scope1', 'g1', '2026-01-01', 1);

  const row = await getTransaction(db, 'scope1', 'g1');
  expect(row).toMatchObject({ id: 'g1', occurredAt: '2026-01-01', dirty: true });
  await expect(getTransaction(db, 'scope2', 'g1')).resolves.toBeNull();
  await expect(getTransaction(db, 'scope1', 'missing')).resolves.toBeNull();
});

test('upsertServerTransactions 跳过 dirty 行、写入干净行、单事务', async () => {
  const { db, transactions, runLog, rowKey, txCount } = createFakeDb();
  seed(transactions, rowKey, 'scope1', 'dirty-id', '2026-01-01', 1);

  const item = (id: string, date: string, updatedAt: string) => ({
    id,
    attributes: { transactions: [{ date, updatedAt }] },
  });
  await upsertServerTransactions(db, 'scope1', [
    item('dirty-id', '2026-09-09', '2026-09-09T00:00:00Z'),
    item('clean-id', '2026-10-01', '2026-10-01T00:00:00Z'),
  ] as any);

  // dirty 行原样保留
  expect(transactions.get(rowKey('scope1', 'dirty-id'))).toMatchObject({
    payload: JSON.stringify({ id: 'dirty-id', attributes: { transactions: [] } }),
    occurred_at: '2026-01-01',
  });
  // 干净行被 upsert，occurred_at / server_updated_at 正确
  expect(transactions.get(rowKey('scope1', 'clean-id'))).toMatchObject({
    occurred_at: '2026-10-01',
    server_updated_at: '2026-10-01T00:00:00Z',
    dirty: 0,
  });
  expect(txCount()).toBe(1);

  // 断言真实 INSERT 语句形态：dirty 列存在且值字面量为 0（防实现回归）
  const insertSql = runLog.find((call) => /INSERT INTO transactions/i.test(call.sql))?.sql;
  expect(insertSql).toContain('(scope_id, id, payload, occurred_at, server_updated_at, dirty)');
  expect(insertSql).toContain('VALUES (?, ?, ?, ?, ?, 0)');
});

test('deleteLocalTransaction 只删除 dirty=0 的行', async () => {
  const { db, transactions, rowKey } = createFakeDb();
  seed(transactions, rowKey, 'scope1', 'clean', '2026-01-01', 0);
  seed(transactions, rowKey, 'scope1', 'dirty', '2026-01-01', 1);
  seed(transactions, rowKey, 'scope2', 'clean', '2026-01-01', 0);

  await deleteLocalTransaction(db, 'scope1', 'clean');
  await deleteLocalTransaction(db, 'scope1', 'dirty');

  expect(transactions.has(rowKey('scope1', 'clean'))).toBe(false);
  expect(transactions.has(rowKey('scope1', 'dirty'))).toBe(true);
  expect(transactions.has(rowKey('scope2', 'clean'))).toBe(true);
});

test('reconcileDeletions 删除未见过的干净行并写 notices，返回条数，单事务', async () => {
  const { db, transactions, notices, runLog, rowKey, txCount } = createFakeDb();
  seed(transactions, rowKey, 'scope1', 'seen', '2026-01-01', 0);
  seed(transactions, rowKey, 'scope1', 'deleted', '2026-01-02', 0);
  seed(transactions, rowKey, 'scope1', 'dirty', '2026-01-03', 1);
  seed(transactions, rowKey, 'scope2', 'other', '2026-01-04', 0);

  const count = await reconcileDeletions(db, 'scope1', new Set(['seen']));

  expect(count).toBe(1);
  expect(transactions.has(rowKey('scope1', 'seen'))).toBe(true);
  expect(transactions.has(rowKey('scope1', 'deleted'))).toBe(false);
  expect(transactions.has(rowKey('scope1', 'dirty'))).toBe(true);
  expect(transactions.has(rowKey('scope2', 'other'))).toBe(true);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    scope_id: 'scope1',
    kind: 'server_deletion',
    entity_id: 'deleted',
    server_payload: JSON.stringify({ id: 'deleted', attributes: { transactions: [] } }),
    local_payload: null,
    acknowledged_at: null,
  });
  expect(notices[0].id).toBeTruthy();
  expect(notices[0].detected_at).toBeTruthy();
  expect(txCount()).toBe(1);

  // 断言真实 notices INSERT 语句形态：kind 字面量与 NULL 位置（防实现回归）
  const noticeSql = runLog.find((call) => /INSERT INTO notices/i.test(call.sql))?.sql;
  expect(noticeSql).toContain('(scope_id, id, kind, entity_id, local_payload, server_payload, detected_at, acknowledged_at)');
  expect(noticeSql).toContain("VALUES (?, ?, 'server_deletion', ?, NULL, ?, ?, NULL)");
});
