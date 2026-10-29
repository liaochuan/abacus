import {
  LocalWriteError, isServerNewer, pushUpdate, writeNotice,
} from '../syncPush';
import type { Db } from '../types';
import type { OutboxItem } from '../outbox';
import type { TransactionSplitType, TransactionType } from '../../models/transactions';

// 假 Db：只模拟 push update 用到的 SQL 形态（notices 插入、交易回写、outbox 删行/标 failed），
// 未识别的语句直接抛错，防止实现漂移。全程无网络、无真实 SQLite。

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

type NoticeRow = {
  scope_id: string;
  id: string;
  kind: string;
  entity_id: string;
  local_payload: string | null;
  server_payload: string;
  detected_at: string;
  acknowledged_at: string | null;
};

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const createFakeDb = (options: { failRunPattern?: RegExp } = {}) => {
  const outbox: OutboxRow[] = [];
  const transactions: TxRow[] = [];
  const notices: NoticeRow[] = [];
  const runLog: Array<{ sql: string; params: unknown[] }> = [];

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

      if (/^INSERT INTO notices \(scope_id, id, kind, entity_id, local_payload, server_payload, detected_at, acknowledged_at\) VALUES \(\?, \?, \?, \?, \?, \?, \?, NULL\)$/i.test(s)) {
        const [scopeId, id, kind, entityId, localPayload, serverPayload, detectedAt] = params as [
          string, string, string, string, string | null, string, string,
        ];
        notices.push({
          scope_id: scopeId,
          id,
          kind,
          entity_id: entityId,
          local_payload: localPayload,
          server_payload: serverPayload,
          detected_at: detectedAt,
          acknowledged_at: null,
        });
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
      if (/^UPDATE notices SET local_payload = \?, server_payload = \?, detected_at = \? WHERE id = \?$/i.test(s)) {
        const [localPayload, serverPayload, detectedAt, id] = params as [
          string | null, string, string, string,
        ];
        const row = notices.find((r) => r.id === id);
        if (row) {
          row.local_payload = localPayload;
          row.server_payload = serverPayload;
          row.detected_at = detectedAt;
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
      checkPlaceholders(sql, params);
      throw new Error(`unexpected all sql: ${sql}`);
    },
    get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      checkPlaceholders(sql, params);
      const s = normalize(sql);
      if (/^SELECT id FROM notices WHERE scope_id = \? AND entity_id = \? AND kind = \? AND acknowledged_at IS NULL ORDER BY detected_at DESC, id ASC LIMIT 1$/i.test(s)) {
        const [scopeId, entityId, kind] = params as [string, string, string];
        const row = notices
          .filter((r) => r.scope_id === scopeId && r.entity_id === entityId
            && r.kind === kind && r.acknowledged_at === null)
          .sort((a, b) => (a.detected_at === b.detected_at
            ? (a.id < b.id ? -1 : 1)
            : (a.detected_at < b.detected_at ? 1 : -1)))[0];
        return (row ? { id: row.id } : null) as unknown as T | null;
      }
      throw new Error(`unexpected get sql: ${sql}`);
    },
    tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };

  return {
    db, outbox, transactions, notices, runLog,
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

const localPayload = (overrides: Partial<TransactionSplitType> = {}): TransactionType => ({
  id: '42',
  type: 'transactions',
  attributes: {
    groupTitle: 'Groceries',
    transactions: [splitOf(overrides)],
    user: 'me',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  },
} as unknown as TransactionType);

const serverPayload = (updatedAt: string, groupTitle = 'Groceries'): TransactionType => ({
  id: '42',
  type: 'transactions',
  attributes: {
    groupTitle,
    transactions: [{ ...splitOf(), updatedAt }],
    user: 'me',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt,
  },
} as unknown as TransactionType);

// Firefly 原始响应（snake_case）：验证 pushUpdate 落库前会归一化成 camelCase。
const snakeServerPayload = (updatedAt: string, groupTitle = 'Groceries') => ({
  id: '42',
  type: 'transactions',
  attributes: {
    group_title: groupTitle,
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
    }],
    user: 'me',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: updatedAt,
  },
});

const itemOf = (overrides: Partial<OutboxItem> = {}): OutboxItem => ({
  id: 'ob1',
  op: 'update',
  entityId: '42',
  baseUpdatedAt: '2026-10-01T00:00:00Z',
  payload: localPayload(),
  status: 'pending',
  attempts: 0,
  lastError: null,
  createdAt: '2026-10-01T00:00:00Z',
  ...overrides,
});

const seedTx = (transactions: TxRow[], overrides: Partial<TxRow> = {}) => {
  transactions.push({
    scope_id: 'scope1',
    id: '42',
    payload: JSON.stringify(localPayload()),
    occurred_at: '2026-10-01T00:00:00Z',
    server_updated_at: '2026-10-01T00:00:00Z',
    dirty: 1,
    ...overrides,
  });
};

const seedOutbox = (outbox: OutboxRow[], overrides: Partial<OutboxRow> = {}) => {
  outbox.push({
    scope_id: 'scope1',
    id: 'ob1',
    op: 'update',
    entity_id: '42',
    base_updated_at: '2026-10-01T00:00:00Z',
    payload: JSON.stringify(localPayload()),
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  });
};

const makeCtx = (get: jest.Mock, put: jest.Mock) => ({
  backendURL: 'https://ff.test',
  http: { get, put } as any,
});

describe('isServerNewer', () => {
  test('服务端更新时间比较', () => {
    expect(isServerNewer('2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z')).toBe(true);
    expect(isServerNewer('2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')).toBe(false);
    expect(isServerNewer(null, '2026-10-01T00:00:00Z')).toBe(false);
    expect(isServerNewer('2026-10-01T00:00:00Z', null)).toBe(true);
  });

  test('双方都缺基线时不判定为更新（无证据不报冲突）', () => {
    expect(isServerNewer(null, null)).toBe(false);
  });
});

describe('writeNotice', () => {
  test('插入 notices：生成 uuid 与 detected_at，未确认', async () => {
    const { db, notices, runLog } = createFakeDb();

    await writeNotice(db, 'scope1', {
      kind: 'conflict',
      entityId: '42',
      localPayload: '{"local":true}',
      serverPayload: '{"server":true}',
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      scope_id: 'scope1',
      kind: 'conflict',
      entity_id: '42',
      local_payload: '{"local":true}',
      server_payload: '{"server":true}',
      acknowledged_at: null,
    });
    expect(notices[0].id).toMatch(UUID_V4);
    expect(notices[0].detected_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // 所有值都走绑定参数，且 scope_id 在第一条
    expect(runLog[0].params[0]).toBe('scope1');
  });

  test('server_deletion 不带 localPayload 时绑定 NULL', async () => {
    const { db, notices, runLog } = createFakeDb();

    await writeNotice(db, 'scope1', { kind: 'server_deletion', entityId: '42', serverPayload: '{}' });

    expect(notices[0].local_payload).toBeNull();
    expect(runLog[0].params[4]).toBeNull();
  });

  test('同一 entity/kind 重复调用只保留一条未确认通知，内容刷新为最新', async () => {
    const { db, notices } = createFakeDb();

    await writeNotice(db, 'scope1', {
      kind: 'conflict',
      entityId: '42',
      localPayload: '{"v":1}',
      serverPayload: '{"s":1}',
    });
    const firstId = notices[0].id;
    const firstDetectedAt = notices[0].detected_at;

    await writeNotice(db, 'scope1', {
      kind: 'conflict',
      entityId: '42',
      localPayload: '{"v":2}',
      serverPayload: '{"s":2}',
    });

    expect(notices).toHaveLength(1);
    expect(notices[0].id).toBe(firstId);
    expect(notices[0].local_payload).toBe('{"v":2}');
    expect(notices[0].server_payload).toBe('{"s":2}');
    expect(notices[0].acknowledged_at).toBeNull();
    expect(notices[0].detected_at >= firstDetectedAt).toBe(true);
  });

  test('已确认的旧通知不被复用：新的冲突另起一行', async () => {
    const { db, notices } = createFakeDb();

    await writeNotice(db, 'scope1', { kind: 'conflict', entityId: '42', serverPayload: '{"s":1}' });
    const firstId = notices[0].id;
    notices[0].acknowledged_at = '2026-10-02T00:00:00Z';

    await writeNotice(db, 'scope1', { kind: 'conflict', entityId: '42', serverPayload: '{"s":2}' });

    expect(notices).toHaveLength(2);
    expect(notices[1].id).not.toBe(firstId);
    expect(notices[1].server_payload).toBe('{"s":2}');
  });
});

describe('pushUpdate', () => {
  test('服务端未更新：直接 PUT，回写响应并删除 outbox 行，返回 updated', async () => {
    const {
      db, outbox, transactions, notices, runLog,
    } = createFakeDb();
    seedTx(transactions);
    seedOutbox(outbox);

    // 服务端基线与本地的 baseUpdatedAt 相同 → 无冲突
    const get = jest.fn().mockResolvedValue({ data: { data: serverPayload('2026-10-01T00:00:00Z') } });
    const put = jest.fn().mockResolvedValue({ data: { data: serverPayload('2026-10-02T00:00:00Z') } });

    const result = await pushUpdate(db, 'scope1', makeCtx(get, put) as any, itemOf());

    expect(result).toBe('updated');
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('https://ff.test/api/v1/transactions/42');
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      'https://ff.test/api/v1/transactions/42',
      expect.objectContaining({ group_title: 'Groceries', error_if_duplicate_hash: false }),
    );

    expect(notices).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      id: '42',
      dirty: 0,
      server_updated_at: '2026-10-02T00:00:00Z',
      payload: JSON.stringify(serverPayload('2026-10-02T00:00:00Z')),
    });

    // 先回写本地行、再删 outbox 行
    const replaceIndex = runLog.findIndex((c) => /^UPDATE transactions SET payload/i.test(normalize(c.sql)));
    const deleteIndex = runLog.findIndex((c) => /^DELETE FROM outbox WHERE id = \?$/i.test(normalize(c.sql)));
    expect(replaceIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(replaceIndex);
  });

  test('服务端更新更晚：写冲突通知（本地版本 + 服务端版本），仍以本地覆盖并返回 conflict', async () => {
    const {
      db, outbox, transactions, notices,
    } = createFakeDb();
    seedTx(transactions);
    seedOutbox(outbox);

    const item = itemOf();
    const remote = serverPayload('2026-10-02T00:00:00Z', 'Server Edited');
    const get = jest.fn().mockResolvedValue({ data: { data: remote } });
    // 服务端按 PUT 内容回显，并刷新 updated_at
    const put = jest.fn().mockResolvedValue({ data: { data: serverPayload('2026-10-03T00:00:00Z') } });

    const result = await pushUpdate(db, 'scope1', makeCtx(get, put) as any, item);

    expect(result).toBe('conflict');

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      scope_id: 'scope1',
      kind: 'conflict',
      entity_id: '42',
      local_payload: JSON.stringify(item.payload),
      server_payload: JSON.stringify(remote),
      acknowledged_at: null,
    });
    expect(notices[0].id).toMatch(UUID_V4);

    // 本地优先：PUT 用的是本地组标题，而不是服务端改过的版本
    const body = (put.mock.calls[0][1] as { group_title: string });
    expect(body.group_title).toBe('Groceries');

    expect(outbox).toHaveLength(0);
    expect(transactions[0]).toMatchObject({
      dirty: 0,
      server_updated_at: '2026-10-03T00:00:00Z',
      payload: JSON.stringify(serverPayload('2026-10-03T00:00:00Z')),
    });
  });

  test('baseUpdatedAt 为 NULL（基线未知）：记为冲突但照常用本地覆盖', async () => {
    const {
      db, outbox, transactions, notices,
    } = createFakeDb();
    seedTx(transactions, { server_updated_at: null });
    seedOutbox(outbox, { base_updated_at: null });

    const get = jest.fn().mockResolvedValue({ data: { data: serverPayload('2026-10-05T00:00:00Z') } });
    const put = jest.fn().mockResolvedValue({ data: { data: serverPayload('2026-10-06T00:00:00Z') } });

    const result = await pushUpdate(
      db,
      'scope1',
      makeCtx(get, put) as any,
      itemOf({ baseUpdatedAt: null }),
    );

    expect(result).toBe('conflict');
    expect(notices).toHaveLength(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(outbox).toHaveLength(0);
  });

  test('PUT 返回 404：标记 failed（last_error=404），不写通知、不改本地行', async () => {
    const {
      db, outbox, transactions, notices,
    } = createFakeDb();
    seedTx(transactions);
    seedOutbox(outbox);

    const get = jest.fn().mockResolvedValue({ data: { data: serverPayload('2026-10-01T00:00:00Z') } });
    const put = jest.fn().mockRejectedValue({ isAxiosError: true, response: { status: 404 } });

    const result = await pushUpdate(db, 'scope1', makeCtx(get, put) as any, itemOf());

    expect(result).toBe('failed');
    expect(notices).toHaveLength(0);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'failed', attempts: 1, last_error: '404' });
    expect(transactions[0]).toMatchObject({
      dirty: 1,
      server_updated_at: '2026-10-01T00:00:00Z',
      payload: JSON.stringify(localPayload()),
    });
  });

  test('PUT 返回 500：错误向上抛，不标记 failed，outbox 保持 pending', async () => {
    const {
      db, outbox, transactions, notices,
    } = createFakeDb();
    seedTx(transactions);
    seedOutbox(outbox);

    const serverError = { isAxiosError: true, response: { status: 503 } };
    const get = jest.fn().mockResolvedValue({ data: { data: serverPayload('2026-10-01T00:00:00Z') } });
    const put = jest.fn().mockRejectedValue(serverError);

    await expect(pushUpdate(db, 'scope1', makeCtx(get, put) as any, itemOf()))
      .rejects.toBe(serverError);

    expect(notices).toHaveLength(0);
    expect(outbox).toHaveLength(1);
    // 不调用 markOutboxFailed：attempts / 退避由 runSync 记录（下轮仍在 pending 重试）。
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect(transactions[0]).toMatchObject({ dirty: 1 });
  });

  test('PUT 返回 401：错误向上抛，不标记 failed，outbox 保持 pending', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedTx(transactions);
    seedOutbox(outbox);

    const authError = { isAxiosError: true, response: { status: 401 } };
    const get = jest.fn().mockResolvedValue({ data: { data: serverPayload('2026-10-01T00:00:00Z') } });
    const put = jest.fn().mockRejectedValue(authError);

    await expect(pushUpdate(db, 'scope1', makeCtx(get, put) as any, itemOf()))
      .rejects.toBe(authError);

    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect(transactions[0]).toMatchObject({ dirty: 1, payload: JSON.stringify(localPayload()) });
  });

  test('GET 返回 401：错误向上抛（交 withAuthRetry），不改 outbox、不发 PUT', async () => {
    const { db, outbox } = createFakeDb();
    seedOutbox(outbox);

    const authError = { isAxiosError: true, response: { status: 401 } };
    const get = jest.fn().mockRejectedValue(authError);
    const put = jest.fn();

    await expect(pushUpdate(db, 'scope1', makeCtx(get, put) as any, itemOf()))
      .rejects.toBe(authError);

    expect(put).not.toHaveBeenCalled();
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
  });

  test('2xx 但响应体缺 id：抛 LocalWriteError，outbox 保持 pending', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedTx(transactions);
    seedOutbox(outbox);

    const get = jest.fn().mockResolvedValue({ data: { data: serverPayload('2026-10-01T00:00:00Z') } });
    const put = jest.fn().mockResolvedValue({
      data: { data: { type: 'transactions', attributes: { transactions: [] } } },
    });

    const error = await pushUpdate(db, 'scope1', makeCtx(get, put) as any, itemOf())
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LocalWriteError);
    expect(((error as { cause?: Error }).cause)?.message).toBe('transaction update response missing id');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'pending', last_error: null });
    expect(transactions[0]).toMatchObject({ dirty: 1 });
  });

  test('GET 返回 404（服务端已删除）：标记 failed（last_error=404），不再 PUT', async () => {
    const {
      db, outbox, transactions, notices,
    } = createFakeDb();
    seedTx(transactions);
    seedOutbox(outbox);

    const get = jest.fn().mockRejectedValue({ isAxiosError: true, response: { status: 404 } });
    const put = jest.fn();

    const result = await pushUpdate(db, 'scope1', makeCtx(get, put) as any, itemOf());

    expect(result).toBe('failed');
    expect(put).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0);
    expect(outbox[0]).toMatchObject({ status: 'failed', attempts: 1, last_error: '404' });
  });

  test('GET 网络错误：无法确认基线时向上抛，outbox 保持 pending 等下一轮', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedTx(transactions);
    seedOutbox(outbox);

    const networkError = new TypeError('Failed to fetch');
    const get = jest.fn().mockRejectedValue(networkError);
    const put = jest.fn();

    await expect(pushUpdate(db, 'scope1', makeCtx(get, put) as any, itemOf())).rejects.toBe(networkError);

    expect(put).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
  });

  test('snake_case 响应在落库前归一化成 camelCase', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedTx(transactions);
    seedOutbox(outbox);

    const get = jest.fn().mockResolvedValue({ data: { data: snakeServerPayload('2026-10-01T00:00:00Z') } });
    const put = jest.fn().mockResolvedValue({ data: { data: snakeServerPayload('2026-10-02T00:00:00Z') } });

    const result = await pushUpdate(db, 'scope1', makeCtx(get, put) as any, itemOf());

    expect(result).toBe('updated');
    const stored = JSON.parse(transactions[0].payload);
    expect(stored.attributes.groupTitle).toBe('Groceries');
    expect(stored.attributes).not.toHaveProperty('group_title');
    expect(stored.attributes.transactions[0].sourceName).toBe('Cash');
    expect(stored.attributes.transactions[0]).not.toHaveProperty('source_name');
    expect(transactions[0].server_updated_at).toBe('2026-10-02T00:00:00Z');
  });

  test('2xx 但响应体为空：用本地 payload 回写，且不从本地 payload 推导基线', async () => {
    const {
      db, outbox, transactions, notices,
    } = createFakeDb();
    // 旧基线故意早于本地 payload 里的 split updatedAt，确认不被本地陈旧值覆盖
    seedTx(transactions, { server_updated_at: '2026-09-01T00:00:00Z' });
    seedOutbox(outbox);

    const get = jest.fn().mockResolvedValue({ data: { data: serverPayload('2026-09-01T00:00:00Z') } });
    const put = jest.fn().mockResolvedValue({ data: {} });

    const result = await pushUpdate(db, 'scope1', makeCtx(get, put) as any, itemOf());

    expect(result).toBe('updated');
    expect(notices).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    // 空响应体 → 传 null 基线，COALESCE 保留旧值（本地 payload 的 updatedAt 是 2026-10-01）
    expect(transactions[0]).toMatchObject({
      dirty: 0,
      server_updated_at: '2026-09-01T00:00:00Z',
      payload: JSON.stringify(localPayload()),
    });
  });

  test('非 update 项：不发任何请求，直接抛错', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedTx(transactions);
    seedOutbox(outbox);

    const get = jest.fn();
    const put = jest.fn();

    await expect(pushUpdate(db, 'scope1', makeCtx(get, put) as any, itemOf({ op: 'create' })))
      .rejects.toThrow('pushUpdate received a non-update item');

    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
  });

  test('entityId 在 GET/PUT URL 中做 URL 编码', async () => {
    const { db, outbox, transactions } = createFakeDb();
    seedTx(transactions);
    seedOutbox(outbox);

    const get = jest.fn().mockResolvedValue({ data: { data: serverPayload('2026-10-01T00:00:00Z') } });
    const put = jest.fn().mockResolvedValue({ data: { data: serverPayload('2026-10-02T00:00:00Z') } });

    await pushUpdate(db, 'scope1', makeCtx(get, put) as any, itemOf({ entityId: '42/1' }));

    expect(get).toHaveBeenCalledWith('https://ff.test/api/v1/transactions/42%2F1');
    expect(put.mock.calls[0][0]).toBe('https://ff.test/api/v1/transactions/42%2F1');
  });
});
