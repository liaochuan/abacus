import {
  localTransactionId,
  occurredAtOf,
  saveLocalTransaction,
  transactionToLocal,
} from '../repository';
import type { Db } from '../types';
import type { TransactionType } from '../../models/transactions';

// 交易组的最小可用 payload；date 是 occurred_at 的来源。
function payloadOf(date: string, amount = '1'): TransactionType {
  return {
    id: '',
    type: 'transactions',
    attributes: {
      groupTitle: 'g',
      transactions: [{
        amount,
        description: '',
        type: 'withdrawal',
        categoryId: '',
        categoryName: '',
        budgetId: '',
        budgetName: '',
        currencyCode: 'CNY',
        currencySymbol: '¥',
        date,
        sourceName: 'Cash',
        sourceId: 1,
        destinationName: '',
        destinationId: 0,
        tags: [],
        notes: '',
        foreignAmount: '',
        foreignCurrencyId: '',
        billId: '',
        billName: '',
      }],
      user: '',
      createdAt: '',
      updatedAt: '',
    },
  };
}


// ---- brief 的 TDD 测试（Step 1） ----

test('本地 id 前缀', () => {
  expect(localTransactionId('abc')).toBe('local:abc');
});

test('新建与编辑的本地意图', () => {
  const payload = { attributes: { transactions: [{ date: '2026-10-01T10:00:00Z' }] } } as any;
  const created = transactionToLocal(payload, undefined, null);
  expect(created.op).toBe('create');
  expect(created.id).toMatch(/^local:/);
  expect(created.baseUpdatedAt).toBeNull();

  const updated = transactionToLocal(payload, '42', '2026-10-01T00:00:00Z');
  expect(updated).toEqual({ id: '42', op: 'update', baseUpdatedAt: '2026-10-01T00:00:00Z' });
});

test('occurredAt 取首笔 split 的 date', () => {
  expect(occurredAtOf({ attributes: { transactions: [{ date: '2026-10-01T10:00:00Z' }] } } as any))
    .toBe('2026-10-01T10:00:00Z');
});

// ---- 纯函数补充断言 ----

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('新建时每次生成不同的 local:<uuid>', () => {
  const first = transactionToLocal(payloadOf('2026-10-01T10:00:00Z'), undefined, null);
  const second = transactionToLocal(payloadOf('2026-10-01T10:00:00Z'), undefined, null);

  expect(first.id).not.toBe(second.id);
  expect(first.id.slice('local:'.length)).toMatch(UUID_V4);
});

test('新建时忽略传入的 baseUpdatedAt，编辑时即使 base 为 null 也照原样保留', () => {
  expect(transactionToLocal(payloadOf('2026-10-01T10:00:00Z'), undefined, '2026-01-01T00:00:00Z'))
    .toMatchObject({ op: 'create', baseUpdatedAt: null });
  expect(transactionToLocal(payloadOf('2026-10-01T10:00:00Z'), '42', null))
    .toEqual({ id: '42', op: 'update', baseUpdatedAt: null });
});

test('空字符串 id 视为新建，不产生 id 为空的编辑意图', () => {
  const intent = transactionToLocal(payloadOf('2026-10-01T10:00:00Z'), '', '2026-01-01T00:00:00Z');

  expect(intent.op).toBe('create');
  expect(intent.id).toMatch(/^local:/);
  expect(intent.baseUpdatedAt).toBeNull();
});

// ---- 内存版 transactions/outbox 假 DB：验证 SQL 形态、绑定参数与事务边界 ----

type TxRow = {
  scope_id: string;
  id: string;
  payload: string;
  occurred_at: string;
  server_updated_at: string | null;
  dirty: number;
};

type OutboxRow = {
  scope_id: string;
  id: string;
  op: string;
  entity_id: string;
  base_updated_at: string | null;
  payload: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
};

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const byCreatedAt = (a: OutboxRow, b: OutboxRow) => {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  return a.id < b.id ? -1 : 1;
};

const createFakeDb = () => {
  const transactions = new Map<string, TxRow>();
  const outbox: OutboxRow[] = [];
  const runLog: Array<{ sql: string; params: unknown[]; inTx: boolean }> = [];
  const queryLog: Array<{ kind: 'all' | 'get'; sql: string; params: unknown[]; inTx: boolean }> = [];
  // 统一按调用顺序记录 run 与 get/all，用于断言「先读旧值、再写新行」。
  const log: Array<{ kind: 'run' | 'all' | 'get'; sql: string; inTx: boolean }> = [];
  let txCount = 0;
  let txDepth = 0;
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
      runLog.push({ sql, params, inTx: txDepth > 0 });
      log.push({ kind: 'run', sql, inTx: txDepth > 0 });
      checkPlaceholders(sql, params);
      const s = normalize(sql);
      if (/^INSERT OR REPLACE INTO transactions/i.test(s)) {
        const [scopeId, id, payload, occurredAt, serverUpdatedAt] = params as [
          string, string, string, string, string | null,
        ];
        // dirty 必须是字面量 1（本地未推送标记），不从参数绑定。
        const dirty = /VALUES \(\?, \?, \?, \?, \?, 1\)$/i.test(s) ? 1 : 0;
        transactions.set(rowKey(scopeId, id), {
          scope_id: scopeId,
          id,
          payload,
          occurred_at: occurredAt,
          server_updated_at: serverUpdatedAt,
          dirty,
        });
        return;
      }
      if (/^INSERT INTO outbox/i.test(s)) {
        const [
          scopeId, id, op, entityId, baseUpdatedAt, payload, status, attempts, lastError, createdAt,
        ] = params as [
          string, string, string, string, string | null,
          string, string, number, string | null, string,
        ];
        outbox.push({
          scope_id: scopeId,
          id,
          op,
          entity_id: entityId,
          base_updated_at: baseUpdatedAt,
          payload,
          status,
          attempts,
          last_error: lastError,
          created_at: createdAt,
        });
        return;
      }
      if (/^UPDATE outbox SET payload = \? WHERE scope_id = \? AND id = \?/i.test(s)) {
        const [payload, scopeId, id] = params as [string, string, string];
        const row = outbox.find((r) => r.scope_id === scopeId && r.id === id);
        if (row) {
          row.payload = payload;
        }
        return;
      }
      throw new Error(`unexpected run sql: ${sql}`);
    },
    all: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      queryLog.push({
        kind: 'all', sql, params, inTx: txDepth > 0,
      });
      log.push({ kind: 'all', sql, inTx: txDepth > 0 });
      checkPlaceholders(sql, params);
      throw new Error(`unexpected all sql: ${sql}`);
    },
    get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      queryLog.push({
        kind: 'get', sql, params, inTx: txDepth > 0,
      });
      log.push({ kind: 'get', sql, inTx: txDepth > 0 });
      checkPlaceholders(sql, params);
      const s = normalize(sql);
      if (/^SELECT server_updated_at FROM transactions WHERE scope_id = \? AND id = \?$/i.test(s)) {
        const [scopeId, id] = params as [string, string];
        const row = transactions.get(rowKey(scopeId, id));
        return (row ? { server_updated_at: row.server_updated_at } : null) as unknown as T | null;
      }
      if (/^SELECT \* FROM outbox WHERE scope_id = \? AND entity_id = \? AND status IN \(\?, \?\)/i.test(s)) {
        const [scopeId, entityId, firstStatus, secondStatus] = params as [string, string, string, string];
        const row = outbox
          .filter((r) => r.scope_id === scopeId && r.entity_id === entityId
            && (r.status === firstStatus || r.status === secondStatus))
          .sort(byCreatedAt)[0];
        return (row ? { ...row } : null) as unknown as T | null;
      }
      if (/^SELECT \* FROM transactions WHERE scope_id = \? AND id = \?$/i.test(s)) {
        const [scopeId, id] = params as [string, string];
        const row = transactions.get(rowKey(scopeId, id));
        return (row ? { ...row } : null) as unknown as T | null;
      }
      throw new Error(`unexpected get sql: ${sql}`);
    },
    // 嵌套事务在真机上会抛 "cannot start a transaction within a transaction"，
    // 这里同样抛错，保证 enqueue 不在 saveLocalTransaction 的事务内再开一层。
    tx: async <T>(fn: () => Promise<T>): Promise<T> => {
      if (txDepth > 0) {
        throw new Error('nested transaction');
      }
      txCount += 1;
      txDepth += 1;
      try {
        return await fn();
      } finally {
        txDepth -= 1;
      }
    },
  };

  return {
    db, transactions, outbox, runLog, queryLog, log, rowKey, txCount: () => txCount,
  };
};

const seedRow = (
  transactions: Map<string, TxRow>,
  rowKey: (scopeId: string, id: string) => string,
  scopeId: string,
  id: string,
  overrides: Partial<TxRow> = {},
) => {
  transactions.set(rowKey(scopeId, id), {
    scope_id: scopeId,
    id,
    payload: JSON.stringify(payloadOf('2026-01-01T00:00:00Z')),
    occurred_at: '2026-01-01T00:00:00Z',
    server_updated_at: null,
    dirty: 0,
    ...overrides,
  });
};

test('新建交易：生成 local:<uuid>，写 dirty=1 的交易行并入队 pending create', async () => {
  const {
    db, transactions, outbox, runLog, rowKey, txCount,
  } = createFakeDb();
  const payload = payloadOf('2026-10-01T10:00:00Z', '12.5');

  const result = await saveLocalTransaction(db, 'scope1', { payload, baseUpdatedAt: null });

  expect(result.op).toBe('create');
  expect(result.id).toMatch(/^local:/);
  expect(result.id.slice('local:'.length)).toMatch(UUID_V4);

  expect(transactions.get(rowKey('scope1', result.id))).toEqual({
    scope_id: 'scope1',
    id: result.id,
    payload: JSON.stringify(payload),
    occurred_at: '2026-10-01T10:00:00Z',
    server_updated_at: null,
    dirty: 1,
  });

  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({
    scope_id: 'scope1',
    op: 'create',
    entity_id: result.id,
    base_updated_at: null,
    payload: JSON.stringify(payload),
    status: 'pending',
    attempts: 0,
    last_error: null,
  });
  expect(txCount()).toBe(1);

  // 交易行与 outbox 入队都发生在同一个事务里，且 enqueue 没有再开事务。
  expect(runLog.every((call) => call.inTx)).toBe(true);
  expect(runLog.map((call) => normalize(call.sql))).toEqual([
    'INSERT OR REPLACE INTO transactions (scope_id, id, payload, occurred_at, server_updated_at, dirty) VALUES (?, ?, ?, ?, ?, 1)',
    expect.stringMatching(/^INSERT INTO outbox/i),
  ]);
});

test('编辑已有交易：id 不变、dirty=1、保留 server_updated_at，并入队 update', async () => {
  const {
    db, transactions, outbox, log, rowKey,
  } = createFakeDb();
  seedRow(transactions, rowKey, 'scope1', '42', {
    server_updated_at: '2026-10-01T00:00:00Z',
  });
  const payload = payloadOf('2026-10-02T08:00:00Z', '99');

  const result = await saveLocalTransaction(db, 'scope1', {
    id: '42',
    payload,
    baseUpdatedAt: '2026-10-01T00:00:00Z',
  });

  expect(result).toEqual({ id: '42', op: 'update' });
  expect(transactions.get(rowKey('scope1', '42'))).toMatchObject({
    payload: JSON.stringify(payload),
    occurred_at: '2026-10-02T08:00:00Z',
    // 编辑不能清掉服务端基线，否则冲突检测失去依据。
    server_updated_at: '2026-10-01T00:00:00Z',
    dirty: 1,
  });
  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({
    op: 'update',
    entity_id: '42',
    base_updated_at: '2026-10-01T00:00:00Z',
    payload: JSON.stringify(payload),
    status: 'pending',
  });

  // 先读旧值、再写：读必须在写之前，且都带 scope_id。
  const readIndex = log.findIndex((call) => /^SELECT server_updated_at FROM transactions/i.test(normalize(call.sql)));
  const writeIndex = log.findIndex((call) => /^INSERT OR REPLACE INTO transactions/i.test(normalize(call.sql)));
  expect(readIndex).toBeGreaterThanOrEqual(0);
  expect(readIndex).toBeLessThan(writeIndex);
});

test('编辑不存在的 id：server_updated_at 为 null，仍入队 update', async () => {
  const { db, transactions, outbox, rowKey } = createFakeDb();

  const result = await saveLocalTransaction(db, 'scope1', {
    id: 'unknown',
    payload: payloadOf('2026-10-05T00:00:00Z'),
    baseUpdatedAt: null,
  });

  expect(result).toEqual({ id: 'unknown', op: 'update' });
  expect(transactions.get(rowKey('scope1', 'unknown'))).toMatchObject({
    server_updated_at: null,
    dirty: 1,
  });
  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({ op: 'update', entity_id: 'unknown', base_updated_at: null });
});

test('空字符串 id 走新建路径：生成 local:<uuid>，不写入 id 为空的交易行', async () => {
  const {
    db, transactions, outbox, rowKey,
  } = createFakeDb();

  const result = await saveLocalTransaction(db, 'scope1', {
    id: '',
    payload: payloadOf('2026-10-01T00:00:00Z'),
    baseUpdatedAt: null,
  });

  expect(result.op).toBe('create');
  expect(result.id).toMatch(/^local:/);
  expect(transactions.has(rowKey('scope1', ''))).toBe(false);
  expect(transactions.has(rowKey('scope1', result.id))).toBe(true);
  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({
    op: 'create', entity_id: result.id, base_updated_at: null,
  });
});

test('连续编辑新建项：outbox 仍只有一条 create，server_updated_at 始终为 null', async () => {
  const { db, transactions, outbox, rowKey } = createFakeDb();

  const created = await saveLocalTransaction(db, 'scope1', {
    payload: payloadOf('2026-10-01T00:00:00Z', '1'),
    baseUpdatedAt: null,
  });
  const updated = await saveLocalTransaction(db, 'scope1', {
    id: created.id,
    payload: payloadOf('2026-10-01T00:00:00Z', '2'),
    baseUpdatedAt: null,
  });

  expect(updated).toEqual({ id: created.id, op: 'update' });
  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({
    op: 'create',
    entity_id: created.id,
    base_updated_at: null,
    payload: JSON.stringify(payloadOf('2026-10-01T00:00:00Z', '2')),
  });
  expect(transactions.get(rowKey('scope1', created.id))).toMatchObject({
    payload: JSON.stringify(payloadOf('2026-10-01T00:00:00Z', '2')),
    server_updated_at: null,
    dirty: 1,
  });
});

test('按 scope 隔离：同 id 的其它 scope 行与 outbox 不受影响', async () => {
  const {
    db, transactions, outbox, rowKey,
  } = createFakeDb();
  seedRow(transactions, rowKey, 'scope1', '42', { server_updated_at: '2026-01-01T00:00:00Z' });
  seedRow(transactions, rowKey, 'scope2', '42', { server_updated_at: '2026-02-02T00:00:00Z' });

  await saveLocalTransaction(db, 'scope1', {
    id: '42',
    payload: payloadOf('2026-10-09T00:00:00Z'),
    baseUpdatedAt: '2026-01-01T00:00:00Z',
  });

  expect(transactions.get(rowKey('scope1', '42'))).toMatchObject({
    occurred_at: '2026-10-09T00:00:00Z', dirty: 1,
  });
  expect(transactions.get(rowKey('scope2', '42'))).toMatchObject({
    payload: JSON.stringify(payloadOf('2026-01-01T00:00:00Z')),
    occurred_at: '2026-01-01T00:00:00Z',
    server_updated_at: '2026-02-02T00:00:00Z',
    dirty: 0,
  });
  expect(outbox.filter((r) => r.scope_id === 'scope1')).toHaveLength(1);
  expect(outbox.filter((r) => r.scope_id === 'scope2')).toHaveLength(0);
});

test('所有数据值走绑定参数，SQL 里不出现 payload、id 与 scope id', async () => {
  const { db, runLog, queryLog } = createFakeDb();
  const payload = payloadOf('2026-10-01T00:00:00Z', '777');
  payload.attributes.groupTitle = 'secret group title';

  await saveLocalTransaction(db, 'scope1', {
    id: 'local:secret-id',
    payload,
    baseUpdatedAt: '2026-10-01T00:00:00Z',
  });

  const sqls = [...runLog, ...queryLog];
  for (const call of sqls) {
    const s = normalize(call.sql);
    expect(s).not.toContain('secret group title');
    expect(s).not.toContain('local:secret-id');
    expect(s).not.toContain('777');
    // scope 过滤值同样走绑定参数，不能拼进 SQL 文本。
    expect(s).not.toContain('scope1');
  }

  const insert = runLog.find((call) => /^INSERT OR REPLACE INTO transactions/i.test(normalize(call.sql)));
  expect(insert?.params).toEqual([
    'scope1',
    'local:secret-id',
    JSON.stringify(payload),
    '2026-10-01T00:00:00Z',
    null,
  ]);
  // 写入交易行的语句必须显式列出 scope_id 列。
  expect(normalize(insert?.sql ?? '')).toContain('(scope_id, id, payload, occurred_at, server_updated_at, dirty)');
});

test('transactionToLocal 对同一入参稳定返回相同的编辑意图', () => {
  const payload = payloadOf('2026-10-01T00:00:00Z');
  const first = transactionToLocal(payload, '42', 'base');
  const second = transactionToLocal(payload, '42', 'base');

  expect(first).toEqual({ id: '42', op: 'update', baseUpdatedAt: 'base' });
  expect(second).toEqual(first);
});

test('payload 无 split 时 occurred_at 为空串，仍可本地保存', async () => {
  const { db, transactions, rowKey } = createFakeDb();
  const payload = {
    id: '',
    type: 'transactions',
    attributes: {
      groupTitle: '', transactions: [], user: '', createdAt: '', updatedAt: '',
    },
  } as unknown as TransactionType;

  const result = await saveLocalTransaction(db, 'scope1', { payload, baseUpdatedAt: null });

  expect(transactions.get(rowKey('scope1', result.id))).toMatchObject({ occurred_at: '' });
});

