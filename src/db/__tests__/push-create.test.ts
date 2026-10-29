import { LocalWriteError, buildTransactionBody, pushCreate } from '../syncPush';
import type { Db } from '../types';
import type { OutboxItem } from '../outbox';
import type { TransactionSplitType, TransactionType } from '../../models/transactions';

// 假 Db：只在内存里模拟 push create 用到的 SQL 形态与行状态，
// 这样能验证「绑定 → 回写 → 删 outbox 行」的顺序与绑定参数，又不依赖真实 SQLite。
// 所有 SQL 都必须是预期形态，未识别的语句直接抛错，防止实现漂移。

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

type TxRow = {
  scope_id: string;
  id: string;
  payload: string;
  occurred_at: string;
  server_updated_at: string | null;
  dirty: number;
};

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const createFakeDb = (options: { failRunPattern?: RegExp } = {}) => {
  const outbox: OutboxRow[] = [];
  const transactions: TxRow[] = [];
  const runLog: Array<{ sql: string; params: unknown[] }> = [];
  const queryLog: Array<{ kind: 'all' | 'get'; sql: string; params: unknown[] }> = [];

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
      const s = normalize(sql);
      if (options.failRunPattern && options.failRunPattern.test(s)) {
        throw new Error('disk I/O error');
      }

      if (/^DELETE FROM transactions WHERE scope_id = \? AND id = \? AND id <> \?$/i.test(s)) {
        const [scopeId, targetId, localId] = params as [string, string, string];
        const index = transactions.findIndex(
          (r) => r.scope_id === scopeId && r.id === targetId && r.id !== localId,
        );
        if (index >= 0) {
          transactions.splice(index, 1);
        }
        return;
      }
      if (/^UPDATE transactions SET id = \?, dirty = 0, server_updated_at = COALESCE\(\?, server_updated_at\) WHERE scope_id = \? AND id = \?$/i.test(s)) {
        const [serverId, serverUpdatedAt, scopeId, localId] = params as [string, string | null, string, string];
        const row = transactions.find((r) => r.scope_id === scopeId && r.id === localId);
        if (row) {
          row.id = serverId;
          row.dirty = 0;
          if (serverUpdatedAt !== null) {
            row.server_updated_at = serverUpdatedAt;
          }
        }
        return;
      }
      if (/^SELECT id FROM outbox/i.test(s)) {
        throw new Error(`unexpected run sql: ${sql}`);
      }
      if (/^DELETE FROM outbox WHERE scope_id = \? AND entity_id = \? AND status IN \('pending', 'failed'\) AND id <> \?$/i.test(s)) {
        const [scopeId, entityId, keepId] = params as [string, string, string];
        for (let i = outbox.length - 1; i >= 0; i -= 1) {
          const row = outbox[i];
          if (row.scope_id === scopeId && row.entity_id === entityId
            && (row.status === 'pending' || row.status === 'failed') && row.id !== keepId) {
            outbox.splice(i, 1);
          }
        }
        return;
      }
      if (/^UPDATE outbox SET entity_id = \? WHERE scope_id = \? AND id = \?$/i.test(s)) {
        const [entityId, scopeId, id] = params as [string, string, string];
        const row = outbox.find((r) => r.scope_id === scopeId && r.id === id);
        if (row) {
          row.entity_id = entityId;
        }
        return;
      }
      if (/^UPDATE transactions SET payload = \?, occurred_at = \?, server_updated_at = COALESCE\(\?, server_updated_at\), dirty = 0 WHERE scope_id = \? AND id = \?$/i.test(s)) {
        const [payload, occurredAt, serverUpdatedAt, scopeId, id] = params as [
          string, string, string | null, string, string,
        ];
        const row = transactions.find((r) => r.scope_id === scopeId && r.id === id);
        if (row) {
          row.payload = payload;
          row.occurred_at = occurredAt;
          if (serverUpdatedAt !== null) {
            row.server_updated_at = serverUpdatedAt;
          }
          row.dirty = 0;
        }
        return;
      }
      if (/^DELETE FROM outbox WHERE id = \?$/i.test(s)) {
        const [id] = params as [string];
        const index = outbox.findIndex((r) => r.id === id);
        if (index >= 0) {
          outbox.splice(index, 1);
        }
        return;
      }
      if (/^UPDATE outbox SET status = 'failed', attempts = attempts \+ 1, last_error = \? WHERE id = \?$/i.test(s)) {
        const [error, id] = params as [string, string];
        const row = outbox.find((r) => r.id === id);
        if (row) {
          row.status = 'failed';
          row.attempts += 1;
          row.last_error = error;
        }
        return;
      }
      throw new Error(`unexpected run sql: ${sql}`);
    },
    all: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      queryLog.push({ kind: 'all', sql, params });
      checkPlaceholders(sql, params);
      const s = normalize(sql);
      if (/^SELECT id FROM outbox WHERE scope_id = \? AND entity_id = \? AND status IN \('pending', 'failed'\) ORDER BY created_at ASC, id ASC$/i.test(s)) {
        const [scopeId, entityId] = params as [string, string];
        return outbox
          .filter((r) => r.scope_id === scopeId && r.entity_id === entityId
            && (r.status === 'pending' || r.status === 'failed'))
          .sort((a, b) => (a.created_at === b.created_at
            ? (a.id < b.id ? -1 : 1)
            : (a.created_at < b.created_at ? -1 : 1)))
          .map((r) => ({ id: r.id })) as unknown as T[];
      }
      throw new Error(`unexpected all sql: ${sql}`);
    },
    get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      queryLog.push({ kind: 'get', sql, params });
      checkPlaceholders(sql, params);
      const s = normalize(sql);
      if (/^SELECT 1 AS one FROM transactions WHERE scope_id = \? AND id = \?$/i.test(s)) {
        const [scopeId, id] = params as [string, string];
        const exists = transactions.some((r) => r.scope_id === scopeId && r.id === id);
        return (exists ? { one: 1 } : null) as unknown as T | null;
      }
      throw new Error(`unexpected get sql: ${sql}`);
    },
    tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };

  return {
    db, outbox, transactions, runLog, queryLog,
  };
};

const splitOf = (overrides: Partial<TransactionSplitType> = {}): TransactionSplitType => ({
  description: 'coffee',
  amount: '3.50',
  date: '2026-10-01T00:00:00Z',
  type: 'withdrawal',
  sourceName: 'Cash',
  sourceId: 1,
  destinationName: 'Shop',
  destinationId: 2,
  categoryName: 'Food',
  categoryId: '3',
  budgetName: '',
  budgetId: '',
  billId: '',
  billName: '',
  tags: ['a'],
  notes: 'note',
  foreignAmount: '',
  foreignCurrencyId: '',
  currencyCode: 'CNY',
  currencySymbol: '¥',
  ...overrides,
});

const payloadOf = (overrides: Partial<TransactionSplitType> = {}): TransactionType => ({
  id: 'local:1',
  type: 'transactions',
  attributes: {
    groupTitle: 'Groceries',
    transactions: [splitOf(overrides)],
    user: '',
    createdAt: '',
    updatedAt: '',
  },
} as TransactionType);

const itemOf = (overrides: Partial<OutboxItem> = {}): OutboxItem => ({
  id: 'ob1',
  op: 'create',
  entityId: 'local:1',
  baseUpdatedAt: null,
  payload: payloadOf(),
  status: 'pending',
  attempts: 0,
  lastError: null,
  createdAt: '2026-10-01T00:00:00Z',
  ...overrides,
});

const serverTransaction = (id = '42', updatedAt = '2026-10-02T00:00:00Z'): TransactionType => ({
  id,
  type: 'transactions',
  attributes: {
    groupTitle: 'Groceries',
    transactions: [{ ...splitOf(), updatedAt }],
    user: 'me',
    createdAt: '2026-10-02T00:00:00Z',
    updatedAt,
  },
} as unknown as TransactionType);

// Firefly 原始响应（snake_case）：验证 syncPush 会在落库前统一归一化成 camelCase。
const snakeServerTransaction = (id = '42', updatedAt = '2026-10-02T00:00:00Z') => ({
  id,
  type: 'transactions',
  attributes: {
    group_title: 'Groceries',
    transactions: [{
      description: 'coffee',
      amount: '3.50',
      date: '2026-10-01T00:00:00Z',
      type: 'withdrawal',
      source_name: 'Cash',
      source_id: 1,
      destination_name: 'Shop',
      destination_id: 2,
      category_name: 'Food',
      category_id: '3',
      budget_name: '',
      budget_id: '',
      bill_id: '',
      bill_name: '',
      tags: ['a'],
      notes: 'note',
      foreign_amount: null,
      foreign_currency_id: '',
      updated_at: updatedAt,
      created_at: '2026-10-02T00:00:00Z',
    }],
    user: 'me',
    created_at: '2026-10-02T00:00:00Z',
    updated_at: updatedAt,
  },
});

const seedLocal = (transactions: TxRow[], overrides: Partial<TxRow> = {}) => {
  transactions.push({
    scope_id: 'scope1',
    id: 'local:1',
    payload: JSON.stringify(payloadOf()),
    occurred_at: '2026-10-01T00:00:00Z',
    server_updated_at: null,
    dirty: 1,
    ...overrides,
  });
};

const seedOutbox = (outbox: OutboxRow[], overrides: Partial<OutboxRow> = {}) => {
  outbox.push({
    scope_id: 'scope1',
    id: 'ob1',
    op: 'create',
    entity_id: 'local:1',
    base_updated_at: null,
    payload: JSON.stringify(payloadOf()),
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  });
};

const makeCtx = (post: jest.Mock, get: jest.Mock) => ({
  backendURL: 'https://ff.test',
  http: { post, get } as any,
});

describe('buildTransactionBody', () => {
  test('提交 body 使用 snake_case 且不启用重复哈希', () => {
    const body = buildTransactionBody({
      attributes: {
        groupTitle: 'G',
        transactions: [
          {
            description: 'd', amount: '3.5', date: '2026-10-01T00:00:00Z', type: 'withdrawal',
            sourceName: 'Cash', destinationName: 'Shop', categoryName: 'Food', budgetName: '', tags: ['a'], notes: '',
          },
        ],
      },
    } as any) as any;
    expect(body.group_title).toBe('G');
    expect(body.transactions[0].source_name).toBe('Cash');
    expect(body.transactions[0].amount).toBe(3.5);
    expect(body.error_if_duplicate_hash).toBe(false);
  });

  test('金额去逗号后转数字，空 amount 为 0、空 foreign_amount 为 null', () => {
    const body = buildTransactionBody(payloadOf({ amount: '3,50', foreignAmount: '2,5' }));
    expect(body.transactions[0].amount).toBe(3.5);
    expect(body.transactions[0].foreign_amount).toBe(2.5);

    const empty = buildTransactionBody(payloadOf({ amount: '', foreignAmount: '' }));
    expect(empty.transactions[0].amount).toBe(0);
    expect(empty.transactions[0].foreign_amount).toBeNull();
  });

  test('空字符串 id 转成 undefined（JSON 序列化时字段消失）', () => {
    const body = buildTransactionBody(payloadOf({
      categoryId: '',
      budgetId: '',
      billId: '',
      foreignCurrencyId: '',
      sourceId: '' as unknown as number,
      destinationId: '' as unknown as number,
    }));
    const split = body.transactions[0];
    expect(split.category_id).toBeUndefined();
    expect(split.budget_id).toBeUndefined();
    expect(split.bill_id).toBeUndefined();
    expect(split.foreign_currency_id).toBeUndefined();
    expect(split.source_id).toBeUndefined();
    expect(split.destination_id).toBeUndefined();

    const json = JSON.parse(JSON.stringify(body)) as { transactions: Array<Record<string, unknown>> };
    expect(json.transactions[0]).not.toHaveProperty('category_id');
    expect(json.transactions[0]).not.toHaveProperty('budget_id');
    expect(json.transactions[0]).not.toHaveProperty('bill_id');
    expect(json.transactions[0]).not.toHaveProperty('foreign_currency_id');
    expect(json.transactions[0]).not.toHaveProperty('source_id');
    expect(json.transactions[0]).not.toHaveProperty('destination_id');
  });

  test('非空 id 与文本字段原样保留', () => {
    const body = buildTransactionBody(payloadOf());
    expect(body.transactions[0]).toMatchObject({
      description: 'coffee',
      category_id: '3',
      category_name: 'Food',
      source_id: 1,
      destination_id: 2,
      tags: ['a'],
      notes: 'note',
      date: '2026-10-01T00:00:00Z',
      type: 'withdrawal',
    });
  });
});

describe('pushCreate', () => {
  test('成功后绑定 id、回写服务端 payload 与基线，并删除 outbox 行', async () => {
    const { db, outbox, transactions, runLog } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const post = jest.fn().mockResolvedValue({ data: { data: serverTransaction('42', '2026-10-02T00:00:00Z') } });
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });
    const item = itemOf();

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, item)).resolves.toBe('created');

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      'https://ff.test/api/v1/transactions',
      expect.objectContaining({ group_title: 'Groceries', error_if_duplicate_hash: false }),
    );
    // create 推送前必定先对账一次
    expect(get).toHaveBeenCalledTimes(1);

    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      id: '42',
      dirty: 0,
      server_updated_at: '2026-10-02T00:00:00Z',
      payload: JSON.stringify(serverTransaction('42', '2026-10-02T00:00:00Z')),
    });
    expect(outbox).toHaveLength(0);

    // 回写 SQL 使用响应体的 occurred_at 与组级 updated_at
    const replace = runLog.find((c) => /^UPDATE transactions SET payload/i.test(normalize(c.sql)));
    expect(replace?.params).toEqual([
      JSON.stringify(serverTransaction('42', '2026-10-02T00:00:00Z')),
      '2026-10-01T00:00:00Z',
      '2026-10-02T00:00:00Z',
      'scope1',
      '42',
    ]);
  });

  test('成功后同一 entity 的其它 outbox 行不会残留（合并去重）', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox, { id: 'ob1', created_at: '2026-10-01T00:00:00Z' });
    seedOutbox(outbox, {
      id: 'ob2', created_at: '2026-10-01T00:00:05Z', op: 'update',
    });
    seedOutbox(outbox, { id: 'ob3', entity_id: 'other', created_at: '2026-10-01T00:00:06Z' });

    const post = jest.fn().mockResolvedValue({ data: { data: serverTransaction('42') } });
    const get = jest.fn();

    await pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf());

    expect(outbox.map((r) => r.id)).toEqual(['ob3']);
    expect(outbox[0].entity_id).toBe('other');
  });

  test('网络错误后对账命中唯一重复项：绑定并删除 outbox 行，返回 duplicate', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const networkError = { isAxiosError: true, code: 'ERR_NETWORK', message: 'Network Error' };
    const post = jest.fn().mockRejectedValue(networkError);
    // 第一次是 push 前对账（空），第二次是 POST 失败后的复对账（命中）
    const get = jest.fn()
      .mockResolvedValueOnce({ data: { data: [] } })
      .mockResolvedValueOnce({ data: { data: [serverTransaction('42')] } });

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf())).resolves.toBe('duplicate');

    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
    const url = get.mock.calls[1][0] as string;
    expect(url).toContain('https://ff.test/api/v1/search/transactions?limit=20');
    expect(url).toContain('query=Groceries');

    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      id: '42',
      dirty: 0,
      server_updated_at: '2026-10-02T00:00:00Z',
    });
    expect(outbox).toHaveLength(0);
  });

  test('服务端 5xx 也走对账；未命中时抛出原错误且不改 outbox', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const serverError = { isAxiosError: true, response: { status: 503 } };
    const post = jest.fn().mockRejectedValue(serverError);
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf())).rejects.toBe(serverError);

    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect(transactions[0]).toMatchObject({ id: 'local:1', dirty: 1 });
  });

  test('对账请求自身失败时仍抛出原始 POST 错误', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const networkError = new TypeError('Failed to fetch');
    const post = jest.fn().mockRejectedValue(networkError);
    // push 前对账成功（空），POST 失败后的复对账请求自身失败
    const get = jest.fn()
      .mockResolvedValueOnce({ data: { data: [] } })
      .mockRejectedValueOnce(new Error('Network request failed'));

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf())).rejects.toBe(networkError);
    expect(outbox[0]).toMatchObject({ status: 'pending' });
  });

  test('push 前对账失败：不发起 POST，错误向上抛，outbox 保持 pending', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const post = jest.fn();
    const reconcileError = new TypeError('Failed to fetch');
    const get = jest.fn().mockRejectedValue(reconcileError);

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf())).rejects.toBe(reconcileError);

    expect(post).not.toHaveBeenCalled();
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect(transactions[0]).toMatchObject({ id: 'local:1', dirty: 1 });
  });

  test('推送的是同一 entity 较新的 outbox 行时，绑定保留该行并清掉更早的残留', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox, { id: 'ob-old', created_at: '2026-10-01T00:00:00Z' });
    seedOutbox(outbox, {
      id: 'ob-current', created_at: '2026-10-01T00:00:05Z', op: 'update',
    });

    const post = jest.fn().mockResolvedValue({ data: { data: serverTransaction('42') } });
    const get = jest.fn();

    await pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf({ id: 'ob-current', op: 'update' }));

    // ob-old 被清掉，ob-current 由调用方删除 → 该 entity 在 outbox 无残留
    expect(outbox).toHaveLength(0);
    expect(transactions[0]).toMatchObject({ id: '42', dirty: 0 });
  });

  test('POST 成功但绑定写库失败：抛 LocalWriteError（不标记 failed），outbox 保持 pending', async () => {
    const { db, outbox, transactions } = createFakeDb({
      failRunPattern: /^UPDATE transactions SET id = /i,
    });
    seedLocal(transactions);
    seedOutbox(outbox);

    const post = jest.fn().mockResolvedValue({ data: { data: serverTransaction('42') } });
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });

    const error = await pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf())
      .catch((err: unknown) => err);

    // 本地写库失败必须带上可识别的类型（runSync 据此保持 pending，不标 failed）
    expect(error).toBeInstanceOf(LocalWriteError);
    expect((error as LocalWriteError).message).toBe('local write failed after server accepted the change');
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(((error as { cause?: Error }).cause)?.message).toBe('disk I/O error');

    // 服务端已接受这笔交易，outbox 必须留在 pending 等下一轮对账绑定，不能被标 failed
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect(transactions[0]).toMatchObject({ id: 'local:1', dirty: 1, server_updated_at: null });
    expect(post).toHaveBeenCalledTimes(1);
    // 只做了 push 前那次对账，POST 成功后没有再对账
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('2xx 响应缺少 id：抛 LocalWriteError，不标记 failed，outbox 保持 pending', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const post = jest.fn().mockResolvedValue({ data: { data: {} } });
    const get = jest.fn();

    const error = await pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf())
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LocalWriteError);
    expect((error as LocalWriteError).message).toBe('local write failed after server accepted the change');
    expect(((error as { cause?: Error }).cause)?.message).toBe('transaction create response missing id');

    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect(transactions[0]).toMatchObject({ id: 'local:1', dirty: 1 });
  });

  test('POST 返回 401：错误向上抛，不标记 failed，outbox 保持 pending', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const authError = { isAxiosError: true, response: { status: 401 } };
    const post = jest.fn().mockRejectedValue(authError);
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf()))
      .rejects.toBe(authError);

    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect(transactions[0]).toMatchObject({ id: 'local:1', dirty: 1 });
  });

  test('POST 返回 403：同样上抛且不改 outbox（交给 withAuthRetry）', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const authError = { isAxiosError: true, response: { status: 403 } };
    const post = jest.fn().mockRejectedValue(authError);
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf()))
      .rejects.toBe(authError);
    expect(outbox[0]).toMatchObject({ status: 'pending', last_error: null });
  });

  test('snake_case 的 POST 响应在本地按 camelCase 落库并写入基线', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const post = jest.fn().mockResolvedValue({
      data: { data: snakeServerTransaction('42', '2026-10-02T00:00:00Z') },
    });
    const get = jest.fn();

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf())).resolves.toBe('created');

    const stored = JSON.parse(transactions[0].payload);
    expect(stored.attributes.groupTitle).toBe('Groceries');
    expect(stored.attributes).not.toHaveProperty('group_title');
    expect(stored.attributes.transactions[0].sourceName).toBe('Cash');
    expect(stored.attributes.transactions[0].foreignCurrencyId).toBe('');
    expect(stored.attributes.transactions[0]).not.toHaveProperty('source_name');
    expect(transactions[0].server_updated_at).toBe('2026-10-02T00:00:00Z');
    expect(outbox).toHaveLength(0);
  });

  test('响应缺 updated_at 时不清空已有基线（COALESCE）', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions, { server_updated_at: '2026-09-01T00:00:00Z' });
    seedOutbox(outbox);

    // 服务端响应里没有任何 updated_at：归一化后 groupUpdatedAt 返回 null
    const post = jest.fn().mockResolvedValue({
      data: { data: { id: '42', type: 'transactions', attributes: { transactions: [] } } },
    });
    const get = jest.fn();

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf())).resolves.toBe('created');

    expect(transactions[0]).toMatchObject({
      id: '42', dirty: 0, server_updated_at: '2026-09-01T00:00:00Z',
    });
  });

  test('重试（attempts > 0）先对账：命中唯一重复项时不再 POST', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox, { attempts: 1 });

    const post = jest.fn();
    const get = jest.fn().mockResolvedValue({ data: { data: [serverTransaction('42')] } });

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf({ attempts: 1 })))
      .resolves.toBe('duplicate');

    expect(get).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
    expect(transactions[0]).toMatchObject({
      id: '42', dirty: 0, server_updated_at: '2026-10-02T00:00:00Z',
    });
  });

  test('attempts 为 0 的首次推送也会先对账：命中唯一重复项时不再 POST', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const post = jest.fn();
    const get = jest.fn().mockResolvedValue({ data: { data: [serverTransaction('42')] } });

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf()))
      .resolves.toBe('duplicate');

    expect(get).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
    expect(transactions[0]).toMatchObject({
      id: '42', dirty: 0, server_updated_at: '2026-10-02T00:00:00Z',
    });
  });

  test('重试（attempts > 0）对账未命中时才继续 POST', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox, { attempts: 1 });

    const post = jest.fn().mockResolvedValue({ data: { data: serverTransaction('42') } });
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf({ attempts: 1 })))
      .resolves.toBe('created');

    expect(get).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(outbox).toHaveLength(0);
  });

  test('对账命中两个候选：不绑定、原错误继续向上抛', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const networkError = { isAxiosError: true, code: 'ERR_NETWORK', message: 'Network Error' };
    const post = jest.fn().mockRejectedValue(networkError);
    const get = jest.fn().mockResolvedValue({
      data: { data: [serverTransaction('42'), serverTransaction('43')] },
    });

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf())).rejects.toBe(networkError);

    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect(transactions[0]).toMatchObject({ id: 'local:1', dirty: 1 });
  });

  test('对账候选组创建时间早于入队时间：视为另一笔交易，不绑定', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const networkError = new TypeError('Failed to fetch');
    const post = jest.fn().mockRejectedValue(networkError);
    // item.createdAt 是 2026-10-01T00:00:00Z，候选组创建于更早的一天
    const older = {
      ...serverTransaction('42'),
      attributes: {
        ...serverTransaction('42').attributes,
        createdAt: '2026-09-30T00:00:00Z',
      },
    };
    const get = jest.fn().mockResolvedValue({ data: { data: [older] } });

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf())).rejects.toBe(networkError);
    expect(transactions[0]).toMatchObject({ id: 'local:1', dirty: 1 });
  });

  test('对账候选 split 数量不同：不绑定', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const networkError = new TypeError('Failed to fetch');
    const post = jest.fn().mockRejectedValue(networkError);
    const twoSplits = {
      ...serverTransaction('42'),
      attributes: {
        ...serverTransaction('42').attributes,
        transactions: [
          ...serverTransaction('42').attributes.transactions,
          { ...splitOf({ description: 'tea', amount: '1' }), updatedAt: '2026-10-02T00:00:00Z' },
        ],
      },
    };
    const get = jest.fn().mockResolvedValue({ data: { data: [twoSplits] } });

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf())).rejects.toBe(networkError);
    expect(transactions[0]).toMatchObject({ id: 'local:1', dirty: 1 });
  });

  test('422 等不可重试错误：标记 failed，返回 failed，POST 失败后不再复对账', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedLocal(transactions);
    seedOutbox(outbox);

    const invalid = { isAxiosError: true, response: { status: 422 } };
    const post = jest.fn().mockRejectedValue(invalid);
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });

    await expect(pushCreate(db, 'scope1', makeCtx(post, get) as any, itemOf())).resolves.toBe('failed');

    // 只有 push 前那次对账；422 属于不可重试错误，不再复对账
    expect(get).toHaveBeenCalledTimes(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'failed', attempts: 1, last_error: 'invalid' });
    expect(transactions[0]).toMatchObject({ id: 'local:1', dirty: 1 });
  });
});
