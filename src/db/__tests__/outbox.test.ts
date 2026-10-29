import {
  bindServerId,
  enqueue,
  listOutbox,
  markOutboxFailed,
  mergeIntent,
  removeOutboxItem,
  retryOutboxItem,
} from '../outbox';
import type { Db } from '../types';
import type { TransactionType } from '../../models/transactions';

// ---- brief 的 TDD 测试（Step 1） ----

const create = {
  id: 'o1',
  op: 'create' as const,
  entityId: 'local:1',
  baseUpdatedAt: null,
  payload: { attributes: { groupTitle: 'a', transactions: [{ amount: '1' }] } } as any,
  status: 'pending' as const,
  attempts: 0,
  lastError: null,
  createdAt: 't0',
};

test('create 之后编辑仍然只有 create', () => {
  const merged = mergeIntent(create, {
    op: 'update',
    entityId: 'local:1',
    payload: { attributes: { groupTitle: 'b', transactions: [{ amount: '2' }] } } as any,
  });
  expect(merged.op).toBe('create');
  expect(merged.payload.attributes.groupTitle).toBe('b');
});

test('已有 update 时覆盖 payload 并保留最初的 base', () => {
  const update = {
    ...create,
    op: 'update' as const,
    entityId: '42',
    baseUpdatedAt: '2026-01-01T00:00:00Z',
  };
  const merged = mergeIntent(update, {
    op: 'update',
    entityId: '42',
    payload: { attributes: { groupTitle: 'c', transactions: [] } } as any,
  });
  expect(merged.op).toBe('update');
  expect((merged as any).baseUpdatedAt).toBeUndefined(); // base 由调用方保留，不在返回值里覆盖
});

// ---- 纯函数补充断言 ----

const payloadOf = (groupTitle: string, amount = '1'): TransactionType => ({
  id: '',
  type: 'transactions',
  attributes: {
    groupTitle,
    transactions: [{ amount }],
    user: '',
    createdAt: '',
    updatedAt: '',
  },
} as unknown as TransactionType);

test('mergeIntent 无现有行时沿用意图的 op 与 payload', () => {
  const merged = mergeIntent(null, {
    op: 'update',
    entityId: '42',
    payload: payloadOf('x'),
  });
  expect(merged).toEqual({ op: 'update', payload: payloadOf('x') });
});

// ---- 内存版 outbox/transactions 假 DB：验证 SQL 形态、绑定参数，并模拟真实行状态 ----

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
// 与 SQL `ORDER BY created_at ASC, id ASC` 对齐：同一毫秒内按 id 决定顺序。
const byCreatedAt = (a: OutboxRow, b: OutboxRow) => {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  return a.id < b.id ? -1 : 1;
};
const cloneOutbox = (row: OutboxRow): OutboxRow => ({ ...row });

const createFakeDb = () => {
  const outbox: OutboxRow[] = [];
  const transactions: TxRow[] = [];
  const runLog: Array<{ sql: string; params: unknown[] }> = [];
  const queryLog: Array<{ kind: 'all' | 'get'; sql: string; params: unknown[] }> = [];
  let txCount = 0;

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
      if (/^UPDATE outbox SET payload = \?, status = 'pending', attempts = 0, last_error = NULL WHERE scope_id = \? AND id = \?/i.test(s)) {
        const [payload, scopeId, id] = params as [string, string, string];
        const row = outbox.find((r) => r.scope_id === scopeId && r.id === id);
        if (row) {
          row.payload = payload;
          row.status = 'pending';
          row.attempts = 0;
          row.last_error = null;
        }
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
      if (/^UPDATE outbox SET entity_id = \? WHERE scope_id = \? AND id = \?/i.test(s)) {
        const [entityId, scopeId, id] = params as [string, string, string];
        const row = outbox.find((r) => r.scope_id === scopeId && r.id === id);
        if (row) {
          row.entity_id = entityId;
        }
        return;
      }
      if (/^UPDATE outbox SET status = 'failed', attempts = attempts \+ 1, last_error = \? WHERE id = \?/i.test(s)) {
        const [error, id] = params as [string, string];
        const row = outbox.find((r) => r.id === id);
        if (row) {
          row.status = 'failed';
          row.attempts += 1;
          row.last_error = error;
        }
        return;
      }
      if (/^UPDATE outbox SET status = 'pending', attempts = 0, last_error = NULL WHERE id = \?/i.test(s)) {
        const [id] = params as [string];
        const row = outbox.find((r) => r.id === id);
        if (row) {
          row.status = 'pending';
          row.attempts = 0;
          row.last_error = null;
        }
        return;
      }
      if (/^DELETE FROM outbox WHERE id = \?/i.test(s)) {
        const [id] = params as [string];
        const index = outbox.findIndex((r) => r.id === id);
        if (index >= 0) {
          outbox.splice(index, 1);
        }
        return;
      }
      if (/^DELETE FROM transactions WHERE scope_id = \? AND id = \? AND id <> \?/i.test(s)) {
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
          .sort(byCreatedAt)
          .map((r) => ({ id: r.id })) as unknown as T[];
      }
      if (/^SELECT \* FROM outbox WHERE scope_id = \? AND status = \? ORDER BY created_at ASC, id ASC$/i.test(s)) {
        const [scopeId, status] = params as [string, string];
        return outbox
          .filter((r) => r.scope_id === scopeId && r.status === status)
          .sort(byCreatedAt)
          .map(cloneOutbox) as unknown as T[];
      }
      if (/^SELECT \* FROM outbox WHERE scope_id = \? ORDER BY created_at ASC, id ASC$/i.test(s)) {
        const [scopeId] = params as [string];
        return outbox
          .filter((r) => r.scope_id === scopeId)
          .sort(byCreatedAt)
          .map(cloneOutbox) as unknown as T[];
      }
      throw new Error(`unexpected all sql: ${sql}`);
    },
    get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      queryLog.push({ kind: 'get', sql, params });
      checkPlaceholders(sql, params);
      const s = normalize(sql);
      if (/^SELECT 1 AS one FROM transactions WHERE scope_id = \? AND id = \?/i.test(s)) {
        const [scopeId, id] = params as [string, string];
        const exists = transactions.some((r) => r.scope_id === scopeId && r.id === id);
        return (exists ? { one: 1 } : null) as unknown as T | null;
      }
      if (/^SELECT \* FROM outbox WHERE scope_id = \? AND entity_id = \? AND status IN \(\?, \?\)/i.test(s)) {
        const [scopeId, entityId, firstStatus, secondStatus] = params as [string, string, string, string];
        const row = outbox
          .filter((r) => r.scope_id === scopeId && r.entity_id === entityId
            && (r.status === firstStatus || r.status === secondStatus))
          .sort(byCreatedAt)[0];
        return (row ? cloneOutbox(row) : null) as unknown as T | null;
      }
      throw new Error(`unexpected get sql: ${sql}`);
    },
    tx: async <T>(fn: () => Promise<T>): Promise<T> => {
      txCount += 1;
      return fn();
    },
  };

  return {
    db, outbox, transactions, runLog, queryLog, txCount: () => txCount,
  };
};

const seedRow = (
  outbox: OutboxRow[],
  overrides: Partial<OutboxRow> & { scope_id: string; id: string; created_at: string },
): OutboxRow => {
  const row: OutboxRow = {
    op: 'update',
    entity_id: overrides.id,
    base_updated_at: null,
    payload: JSON.stringify(payloadOf('seed')),
    status: 'pending',
    attempts: 0,
    last_error: null,
    ...overrides,
  };
  outbox.push(row);
  return row;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('enqueue 插入新行：pending、attempts=0、uuid、ISO 时间，且不自开事务', async () => {
  const { db, outbox, txCount } = createFakeDb();
  const payload = payloadOf('a');

  const item = await enqueue(db, 'scope1', { op: 'create', entityId: 'local:1', payload });

  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({
    scope_id: 'scope1',
    id: item.id,
    op: 'create',
    entity_id: 'local:1',
    base_updated_at: null,
    payload: JSON.stringify(payload),
    status: 'pending',
    attempts: 0,
    last_error: null,
  });
  expect(item.id).toMatch(UUID_V4);
  expect(item.createdAt).toBe(outbox[0].created_at);
  expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
  expect(item).toMatchObject({
    op: 'create',
    entityId: 'local:1',
    baseUpdatedAt: null,
    status: 'pending',
    attempts: 0,
    lastError: null,
  });
  expect(item.payload).toEqual(payload);
  // enqueue 不自己 BEGIN：调用方（saveLocalTransaction）持有事务。
  expect(txCount()).toBe(0);
});

test('enqueue 合并到已有 pending create：只更新 payload，保留 op/base/createdAt/attempts', async () => {
  const { db, outbox } = createFakeDb();
  const first = await enqueue(db, 'scope1', {
    op: 'create',
    entityId: 'local:1',
    payload: payloadOf('a'),
    baseUpdatedAt: '2026-01-01T00:00:00Z',
  });
  const second = await enqueue(db, 'scope1', {
    op: 'update',
    entityId: 'local:1',
    payload: payloadOf('b'),
    baseUpdatedAt: '2026-09-09T00:00:00Z',
  });

  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({
    id: first.id,
    op: 'create',
    base_updated_at: '2026-01-01T00:00:00Z',
    created_at: first.createdAt,
    payload: JSON.stringify(payloadOf('b')),
  });
  expect(second.id).toBe(first.id);
  expect(second.op).toBe('create');
  expect(second.payload).toEqual(payloadOf('b'));
  expect(second.createdAt).toBe(first.createdAt);
  expect(second.baseUpdatedAt).toBe('2026-01-01T00:00:00Z');
});

test('enqueue 合并到已有 pending update：保留最初的 base_updated_at', async () => {
  const { db, outbox } = createFakeDb();
  const first = await enqueue(db, 'scope1', {
    op: 'update',
    entityId: '42',
    payload: payloadOf('a'),
    baseUpdatedAt: '2026-01-01T00:00:00Z',
  });
  const second = await enqueue(db, 'scope1', {
    op: 'update',
    entityId: '42',
    payload: payloadOf('z'),
    baseUpdatedAt: '2026-06-06T00:00:00Z',
  });

  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({
    id: first.id,
    op: 'update',
    base_updated_at: '2026-01-01T00:00:00Z',
    payload: JSON.stringify(payloadOf('z')),
  });
  expect(second).toMatchObject({ op: 'update', baseUpdatedAt: '2026-01-01T00:00:00Z' });
});

test('enqueue 复用 failed 行：回到 pending、清 attempts/last_error，保留 op/base/createdAt', async () => {
  const { db, outbox, runLog } = createFakeDb();
  const first = await enqueue(db, 'scope1', {
    op: 'update',
    entityId: '42',
    payload: payloadOf('a'),
    baseUpdatedAt: '2026-01-01T00:00:00Z',
  });
  await markOutboxFailed(db, first.id, 'boom');
  await markOutboxFailed(db, first.id, 'boom again');

  const revived = await enqueue(db, 'scope1', {
    op: 'update',
    entityId: '42',
    payload: payloadOf('b'),
    baseUpdatedAt: '2026-09-09T00:00:00Z',
  });

  // 同一 entity 只应有一行，不能变成 failed + pending 两条
  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({
    id: first.id,
    op: 'update',
    entity_id: '42',
    base_updated_at: '2026-01-01T00:00:00Z',
    created_at: first.createdAt,
    payload: JSON.stringify(payloadOf('b')),
    status: 'pending',
    attempts: 0,
    last_error: null,
  });
  expect(revived).toMatchObject({
    id: first.id,
    op: 'update',
    baseUpdatedAt: '2026-01-01T00:00:00Z',
    status: 'pending',
    attempts: 0,
    lastError: null,
  });
  expect(revived.payload).toEqual(payloadOf('b'));

  const revivalSql = runLog.find((c) => /UPDATE outbox\s+SET payload = \?, status = 'pending'/i.test(c.sql));
  expect(revivalSql?.sql).toContain('attempts = 0');
  expect(revivalSql?.sql).toContain('last_error = NULL');
  expect(revivalSql?.params).toEqual([JSON.stringify(payloadOf('b')), 'scope1', first.id]);
});

test('enqueue 按 scope 隔离，不跨 scope 合并', async () => {
  const { db, outbox } = createFakeDb();
  const first = await enqueue(db, 'scope1', {
    op: 'create',
    entityId: 'local:1',
    payload: payloadOf('a'),
  });
  const otherScope = await enqueue(db, 'scope2', {
    op: 'create',
    entityId: 'local:1',
    payload: payloadOf('c'),
  });

  expect(outbox).toHaveLength(2);
  expect(otherScope.id).not.toBe(first.id);
  expect(outbox.filter((r) => r.scope_id === 'scope1')).toHaveLength(1);
  expect(outbox.filter((r) => r.scope_id === 'scope2')).toHaveLength(1);
});

test('enqueue 在 created_at 相同时按 id 决定合并对象', async () => {
  const { db, outbox, queryLog } = createFakeDb();
  seedRow(outbox, {
    scope_id: 'scope1', id: 'ob-b', entity_id: 'e1', created_at: '2026-01-01T00:00:00.000Z',
  });
  seedRow(outbox, {
    scope_id: 'scope1', id: 'ob-a', entity_id: 'e1', created_at: '2026-01-01T00:00:00.000Z',
  });

  await enqueue(db, 'scope1', { op: 'update', entityId: 'e1', payload: payloadOf('new') });

  expect(outbox).toHaveLength(2);
  expect(outbox.find((r) => r.id === 'ob-a')?.payload).toEqual(JSON.stringify(payloadOf('new')));
  expect(outbox.find((r) => r.id === 'ob-b')?.payload).toEqual(JSON.stringify(payloadOf('seed')));
  const lookup = queryLog.find((q) => q.kind === 'get' && /FROM outbox/i.test(q.sql));
  expect(lookup?.sql).toContain('ORDER BY created_at ASC, id ASC');
});

test('listOutbox 按 created_at 升序、可按 status 过滤、按 scope 隔离', async () => {
  const { db, outbox } = createFakeDb();
  seedRow(outbox, { scope_id: 'scope1', id: 'b', created_at: '2026-01-02T00:00:00Z' });
  seedRow(outbox, {
    scope_id: 'scope1', id: 'a', created_at: '2026-01-01T00:00:00Z', entity_id: 'e-a',
  });
  seedRow(outbox, {
    scope_id: 'scope1',
    id: 'c',
    created_at: '2026-01-03T00:00:00Z',
    status: 'failed',
    attempts: 2,
    last_error: 'boom',
    base_updated_at: '2026-01-01T00:00:00Z',
  });
  seedRow(outbox, { scope_id: 'scope2', id: 'd', created_at: '2026-01-00T00:00:00Z' });

  const all = await listOutbox(db, 'scope1');
  expect(all.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  expect(all[0]).toMatchObject({
    op: 'update',
    entityId: 'e-a',
    baseUpdatedAt: null,
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: '2026-01-01T00:00:00Z',
  });
  expect(all[0].payload).toEqual(payloadOf('seed'));
  expect(all[2]).toMatchObject({
    baseUpdatedAt: '2026-01-01T00:00:00Z', status: 'failed', attempts: 2, lastError: 'boom',
  });

  await expect(listOutbox(db, 'scope1', 'pending')).resolves.toHaveLength(2);
  const failed = await listOutbox(db, 'scope1', 'failed');
  expect(failed.map((r) => r.id)).toEqual(['c']);
  await expect(listOutbox(db, 'scope2')).resolves.toHaveLength(1);
});

test('listOutbox 在 created_at 相同时按 id 升序，排序确定', async () => {
  const { db, outbox, queryLog } = createFakeDb();
  seedRow(outbox, {
    scope_id: 'scope1', id: 'z', created_at: '2026-01-01T00:00:00.000Z',
  });
  seedRow(outbox, {
    scope_id: 'scope1', id: 'a', created_at: '2026-01-01T00:00:00.000Z',
  });
  seedRow(outbox, {
    scope_id: 'scope1', id: 'm', created_at: '2026-01-01T00:00:00.000Z',
  });

  const rows = await listOutbox(db, 'scope1');

  expect(rows.map((r) => r.id)).toEqual(['a', 'm', 'z']);
  const listQueries = queryLog.filter((q) => q.kind === 'all' && /FROM outbox/i.test(q.sql));
  expect(listQueries).toHaveLength(1);
  expect(listQueries[0].sql).toContain('ORDER BY created_at ASC, id ASC');
});

test('bindServerId 单事务内先删同名服务端行，再改写 transactions.id/dirty 与 outbox.entity_id', async () => {
  const {
    db, outbox, transactions, txCount, runLog,
  } = createFakeDb();
  seedRow(outbox, {
    scope_id: 'scope1', id: 'ob1', entity_id: 'local:1', created_at: 't1',
  });
  seedRow(outbox, {
    scope_id: 'scope1', id: 'ob2', entity_id: 'other', created_at: 't2',
  });
  seedRow(outbox, {
    scope_id: 'scope2', id: 'ob3', entity_id: 'local:1', created_at: 't3',
  });
  transactions.push(
    {
      scope_id: 'scope1', id: 'local:1', payload: '{"local":true}', occurred_at: '2026-01-01', server_updated_at: null, dirty: 1,
    },
    // 服务端 id 已被 pull 写入本地，PK 会被 bindServerId 命中
    {
      scope_id: 'scope1', id: '42', payload: '{"server":true}', occurred_at: '2026-01-01', server_updated_at: null, dirty: 0,
    },
    {
      scope_id: 'scope2', id: 'local:1', payload: '{}', occurred_at: '2026-01-01', server_updated_at: null, dirty: 1,
    },
    {
      scope_id: 'scope2', id: '42', payload: '{}', occurred_at: '2026-01-01', server_updated_at: null, dirty: 0,
    },
  );

  await bindServerId(db, 'scope1', 'local:1', '42');

  const scope1Rows = transactions.filter((r) => r.scope_id === 'scope1');
  expect(scope1Rows).toHaveLength(1);
  expect(scope1Rows[0]).toMatchObject({ id: '42', dirty: 0, payload: '{"local":true}' });
  expect(transactions.filter((r) => r.scope_id === 'scope2').map((r) => r.id)).toEqual(['local:1', '42']);
  expect(transactions.find((r) => r.scope_id === 'scope2' && r.id === 'local:1')).toMatchObject({ dirty: 1 });
  expect(outbox.find((r) => r.id === 'ob1')?.entity_id).toBe('42');
  expect(outbox.find((r) => r.id === 'ob2')?.entity_id).toBe('other');
  expect(outbox.find((r) => r.id === 'ob3')?.entity_id).toBe('local:1');
  expect(txCount()).toBe(1);

  const deleteIndex = runLog.findIndex((c) => /DELETE FROM transactions/i.test(c.sql));
  const updateIndex = runLog.findIndex((c) => /UPDATE transactions/i.test(c.sql));
  expect(deleteIndex).toBeGreaterThanOrEqual(0);
  expect(deleteIndex).toBeLessThan(updateIndex);
  expect(runLog[deleteIndex].params).toEqual(['scope1', '42', 'local:1']);
  expect(runLog[updateIndex].params).toEqual(['42', null, 'scope1', 'local:1']);
  const outboxUpdate = runLog.find((c) => /UPDATE outbox SET entity_id/i.test(c.sql));
  expect(outboxUpdate?.params).toEqual(['42', 'scope1', 'ob1']);
});

test('bindServerId 的预删除不会删掉本地行本身（localId 等于 serverId 时）', async () => {
  const { db, transactions } = createFakeDb();
  transactions.push({
    scope_id: 'scope1', id: '42', payload: '{"same":true}', occurred_at: '2026-01-01', server_updated_at: null, dirty: 1,
  });

  await bindServerId(db, 'scope1', '42', '42');

  expect(transactions).toHaveLength(1);
  expect(transactions[0]).toMatchObject({ id: '42', dirty: 0, payload: '{"same":true}' });
});

test('bindServerId 重放是 no-op：本地行已改名时不会删掉服务端行', async () => {
  const {
    db, outbox, transactions, runLog,
  } = createFakeDb();
  seedRow(outbox, {
    scope_id: 'scope1', id: 'ob1', entity_id: 'local:1', created_at: 't1',
  });
  transactions.push(
    {
      scope_id: 'scope1', id: 'local:1', payload: '{"local":true}', occurred_at: '2026-01-01', server_updated_at: null, dirty: 1,
    },
    {
      scope_id: 'scope1', id: '42', payload: '{"server":true}', occurred_at: '2026-01-01', server_updated_at: null, dirty: 0,
    },
  );

  await bindServerId(db, 'scope1', 'local:1', '42');
  expect(transactions).toHaveLength(1);
  expect(transactions[0]).toMatchObject({ id: '42', payload: '{"local":true}', dirty: 0 });

  // 重放（例如响应丢失后重试）：本地 local:1 已不存在，必须整体 no-op
  const logLengthBeforeReplay = runLog.length;
  await bindServerId(db, 'scope1', 'local:1', '42');

  expect(runLog).toHaveLength(logLengthBeforeReplay);
  expect(transactions).toHaveLength(1);
  expect(transactions[0]).toMatchObject({ id: '42', payload: '{"local":true}', dirty: 0 });
  expect(outbox.find((r) => r.id === 'ob1')?.entity_id).toBe('42');
});

test('bindServerId 把组级 updated_at 写进 server_updated_at；未提供时保留旧基线', async () => {
  const { db, transactions } = createFakeDb();
  transactions.push(
    {
      scope_id: 'scope1', id: 'local:1', payload: '{}', occurred_at: '2026-01-01', server_updated_at: null, dirty: 1,
    },
    {
      scope_id: 'scope1', id: 'local:2', payload: '{}', occurred_at: '2026-01-01', server_updated_at: '2026-09-01T00:00:00Z', dirty: 1,
    },
  );

  await bindServerId(db, 'scope1', 'local:1', '42', { serverUpdatedAt: '2026-10-02T00:00:00Z' });
  expect(transactions.find((r) => r.id === '42')).toMatchObject({
    dirty: 0, server_updated_at: '2026-10-02T00:00:00Z',
  });

  await bindServerId(db, 'scope1', 'local:2', '43');
  const second = transactions.find((r) => r.id === '43');
  expect(second).toMatchObject({ dirty: 0 });
  expect(second?.server_updated_at).toBe('2026-09-01T00:00:00Z');
});

test('bindServerId 合并同一 entity 的多行 outbox：保留最早一行并删除其余 pending/failed', async () => {
  const { db, outbox, transactions } = createFakeDb();
  transactions.push({
    scope_id: 'scope1', id: 'local:1', payload: '{}', occurred_at: '2026-01-01', server_updated_at: null, dirty: 1,
  });
  seedRow(outbox, {
    scope_id: 'scope1', id: 'ob-old', entity_id: 'local:1', created_at: 't1',
  });
  seedRow(outbox, {
    scope_id: 'scope1', id: 'ob-new', entity_id: 'local:1', created_at: 't2',
  });
  seedRow(outbox, {
    scope_id: 'scope1', id: 'ob-conflict', entity_id: 'local:1', created_at: 't3', status: 'conflict',
  });
  seedRow(outbox, {
    scope_id: 'scope2', id: 'ob-other-scope', entity_id: 'local:1', created_at: 't4',
  });

  await bindServerId(db, 'scope1', 'local:1', '42');

  expect(outbox.map((r) => `${r.scope_id}:${r.id}:${r.entity_id}:${r.status}`)).toEqual([
    'scope1:ob-old:42:pending',
    'scope1:ob-conflict:local:1:conflict',
    'scope2:ob-other-scope:local:1:pending',
  ]);
});

test('bindServerId 传入 keepOutboxId 时保留调用方正在推送的行，删掉其它残留行', async () => {
  const { db, outbox, transactions } = createFakeDb();
  transactions.push({
    scope_id: 'scope1', id: 'local:1', payload: '{}', occurred_at: '2026-01-01', server_updated_at: null, dirty: 1,
  });
  seedRow(outbox, {
    scope_id: 'scope1', id: 'ob-old', entity_id: 'local:1', created_at: 't1',
  });
  seedRow(outbox, {
    scope_id: 'scope1', id: 'ob-current', entity_id: 'local:1', created_at: 't2', op: 'update',
  });

  // 调用方正在推送较新的 ob-current：它必须存活（随后由调用方按 id 删除），
  // 更早的 ob-old 作为残留被清掉，不能留着继续指向 local id。
  await bindServerId(db, 'scope1', 'local:1', '42', { keepOutboxId: 'ob-current' });

  expect(outbox.map((r) => `${r.id}:${r.entity_id}:${r.op}`)).toEqual(['ob-current:42:update']);
});

test('bindServerId 的 keepOutboxId 不存在时退回保留最早一行', async () => {
  const { db, outbox, transactions } = createFakeDb();
  transactions.push({
    scope_id: 'scope1', id: 'local:1', payload: '{}', occurred_at: '2026-01-01', server_updated_at: null, dirty: 1,
  });
  seedRow(outbox, {
    scope_id: 'scope1', id: 'ob-old', entity_id: 'local:1', created_at: 't1',
  });
  seedRow(outbox, {
    scope_id: 'scope1', id: 'ob-new', entity_id: 'local:1', created_at: 't2',
  });

  await bindServerId(db, 'scope1', 'local:1', '42', { keepOutboxId: 'missing' });

  expect(outbox.map((r) => `${r.id}:${r.entity_id}`)).toEqual(['ob-old:42']);
});

test('removeOutboxItem 只删除指定行', async () => {
  const { db, outbox } = createFakeDb();
  seedRow(outbox, { scope_id: 'scope1', id: 'ob1', created_at: 't1' });
  seedRow(outbox, { scope_id: 'scope1', id: 'ob2', created_at: 't2' });

  await removeOutboxItem(db, 'ob1');

  expect(outbox.map((r) => r.id)).toEqual(['ob2']);
});

test('markOutboxFailed 置 failed、累加 attempts 并记录错误；retryOutboxItem 复位', async () => {
  const { db, outbox } = createFakeDb();
  const target = seedRow(outbox, { scope_id: 'scope1', id: 'ob1', created_at: 't1' });
  const untouched = seedRow(outbox, { scope_id: 'scope1', id: 'ob2', created_at: 't2' });
  const originalPayload = target.payload;

  await markOutboxFailed(db, 'ob1', 'boom');
  expect(target).toMatchObject({
    status: 'failed', attempts: 1, last_error: 'boom', payload: originalPayload,
  });

  await markOutboxFailed(db, 'ob1', 'boom again');
  expect(target).toMatchObject({ status: 'failed', attempts: 2, last_error: 'boom again' });
  expect(untouched).toMatchObject({ status: 'pending', attempts: 0, last_error: null });

  await retryOutboxItem(db, 'ob1');
  expect(target).toMatchObject({
    status: 'pending', attempts: 0, last_error: null, payload: originalPayload,
  });
  expect(untouched).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
});

test('所有数据值都走绑定参数，不拼进 SQL 文本', async () => {
  const { db, outbox, runLog } = createFakeDb();
  await enqueue(db, 'scope1', {
    op: 'create',
    entityId: 'local:1',
    payload: payloadOf('secret title'),
  });
  await enqueue(db, 'scope1', {
    op: 'update',
    entityId: 'local:1',
    payload: payloadOf('secret title 2'),
  });

  const insert = runLog.find((c) => /INSERT INTO outbox/i.test(c.sql));
  expect(insert).toBeDefined();
  expect(insert?.sql).not.toContain('local:1');
  expect(insert?.sql).not.toContain('secret title');
  expect(insert?.sql.split('?')).toHaveLength(11); // 10 个占位符 + 1 段空串

  const update = runLog.find((c) => /UPDATE outbox SET payload/i.test(c.sql));
  expect(update?.sql).not.toContain('secret title 2');
  expect(update?.params).toEqual([JSON.stringify(payloadOf('secret title 2')), 'scope1', outbox[0].id]);
});
