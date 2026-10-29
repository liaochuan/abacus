import {
  dropOutboxItem,
  issueLabel,
  listIssues,
} from '../outbox';
import type { OutboxItem } from '../outbox';
import type { Db } from '../types';
import type { TransactionType } from '../../models/transactions';

// 失败项列表是「需处理」的唯一出口：这里的 SQL 必须带 scope_id，
// 且放弃本地改动时不能把服务端已有的交易行一起删掉。

const payloadOf = (groupTitle: string): TransactionType => ({
  id: '',
  type: 'transactions',
  attributes: {
    groupTitle,
    transactions: [{ amount: '1' }],
    user: '',
    createdAt: '',
    updatedAt: '',
  },
} as unknown as TransactionType);

const item = (over: Partial<OutboxItem> = {}): OutboxItem => ({
  id: 'o1',
  op: 'update',
  entityId: '42',
  baseUpdatedAt: '2026-10-01T00:00:00Z',
  payload: payloadOf('a'),
  status: 'failed',
  attempts: 5,
  lastError: '422',
  createdAt: '2026-10-01T00:00:00Z',
  ...over,
});

// ---- brief 的 TDD 测试（Step 1） ----

test('失败项按原因显示', () => {
  expect(issueLabel({ lastError: '422' } as any)).toBe('transaction_needs_fix');
  expect(issueLabel({ lastError: '404' } as any)).toBe('transaction_gone_on_server');
  expect(issueLabel({ lastError: 'network' } as any)).toBe('transaction_waiting_network');
});

// ---- 补充断言 ----

test('409 与 422 同属「需要修正」，未知原因回落到通用文案', () => {
  expect(issueLabel(item({ lastError: '409' }))).toBe('transaction_needs_fix');
  expect(issueLabel(item({ lastError: 'server' }))).toBe('sync_status_problems');
  expect(issueLabel(item({ lastError: null }))).toBe('sync_status_problems');
  // 原始错误串不直接当词条用：只认固定枚举。
  expect(issueLabel(item({ lastError: 'boom' }))).toBe('sync_status_problems');
});

type OutboxRow = {
  scope_id: string;
  id: string;
  entity_id: string;
  status: string;
  created_at: string;
};

type TxRow = { scope_id: string; id: string; dirty: number };

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const createFakeDb = () => {
  const outbox: OutboxRow[] = [];
  const transactions: TxRow[] = [];
  const runLog: Array<{ sql: string; params: unknown[] }> = [];
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

      if (/^DELETE FROM outbox WHERE scope_id = \? AND entity_id = \?$/i.test(s)) {
        const [scopeId, entityId] = params as [string, string];
        for (let i = outbox.length - 1; i >= 0; i -= 1) {
          if (outbox[i].scope_id === scopeId && outbox[i].entity_id === entityId) {
            outbox.splice(i, 1);
          }
        }
        return;
      }
      if (/^DELETE FROM outbox WHERE scope_id = \? AND id = \?$/i.test(s)) {
        const [scopeId, id] = params as [string, string];
        const index = outbox.findIndex((r) => r.scope_id === scopeId && r.id === id);
        if (index >= 0) {
          outbox.splice(index, 1);
        }
        return;
      }
      if (/^DELETE FROM transactions WHERE scope_id = \? AND id = \?$/i.test(s)) {
        const [scopeId, id] = params as [string, string];
        const index = transactions.findIndex((r) => r.scope_id === scopeId && r.id === id);
        if (index >= 0) {
          transactions.splice(index, 1);
        }
        return;
      }
      if (/^UPDATE transactions SET dirty = 0 WHERE scope_id = \? AND id = \?$/i.test(s)) {
        const [scopeId, id] = params as [string, string];
        const row = transactions.find((r) => r.scope_id === scopeId && r.id === id);
        if (row) {
          row.dirty = 0;
        }
        return;
      }
      throw new Error(`unexpected run sql: ${sql}`);
    },
    all: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      checkPlaceholders(sql, params);
      const s = normalize(sql);
      if (/^SELECT \* FROM outbox WHERE scope_id = \? AND status = \? ORDER BY created_at ASC, id ASC$/i.test(s)) {
        const [scopeId, status] = params as [string, string];
        return outbox
          .filter((r) => r.scope_id === scopeId && r.status === status)
          .sort((a, b) => (a.created_at === b.created_at
            ? (a.id < b.id ? -1 : 1)
            : (a.created_at < b.created_at ? -1 : 1)))
          .map((r) => ({
            ...r,
            op: 'update',
            base_updated_at: null,
            payload: JSON.stringify(payloadOf(r.id)),
            attempts: 5,
            last_error: '422',
          })) as unknown as T[];
      }
      throw new Error(`unexpected all sql: ${sql}`);
    },
    get: async <T>(): Promise<T | null> => null,
    tx: async <T>(fn: () => Promise<T>): Promise<T> => {
      txCount += 1;
      return fn();
    },
  };

  return {
    db, outbox, transactions, runLog, txCount: () => txCount,
  };
};

const seed = (
  outbox: OutboxRow[],
  over: Partial<OutboxRow> & { id: string },
) => {
  const row: OutboxRow = {
    scope_id: 'scope-a',
    entity_id: over.id,
    status: 'failed',
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  };
  outbox.push(row);
  return row;
};

test('listIssues 只返回本 scope 的 failed 行', async () => {
  const { db, outbox } = createFakeDb();
  seed(outbox, { id: 'o1', created_at: '2026-10-01T00:00:00Z' });
  seed(outbox, { id: 'o2', status: 'pending', created_at: '2026-10-02T00:00:00Z' });
  seed(outbox, { id: 'o3', scope_id: 'scope-b', created_at: '2026-10-03T00:00:00Z' });

  const issues = await listIssues(db, 'scope-a');

  expect(issues.map((issue) => issue.id)).toEqual(['o1']);
  expect(issues[0].status).toBe('failed');
});

test('listIssues 在 scope 为空时不查库', async () => {
  const { db } = createFakeDb();
  // all 对未知 SQL 直接抛错：空 scope 若仍查询，本用例会失败。
  await expect(listIssues(db, '')).resolves.toEqual([]);
});

test('放弃本地新建：同事务删除 outbox 行与本地交易行', async () => {
  const { db, outbox, transactions, runLog, txCount } = createFakeDb();
  const row = seed(outbox, { id: 'o1', entity_id: 'local:abc' });
  transactions.push({ scope_id: 'scope-a', id: 'local:abc', dirty: 1 });

  await dropOutboxItem(db, 'scope-a', item({ id: row.id, entityId: 'local:abc' }));

  expect(outbox).toHaveLength(0);
  expect(transactions).toHaveLength(0);
  expect(txCount()).toBe(1);
  // 所有语句都带 scope_id，且参数全部绑定。
  runLog.forEach((entry) => {
    expect(entry.sql).toContain('scope_id = ?');
    expect(entry.params[0]).toBe('scope-a');
  });
});

test('放弃本地新建：删除同一 entity 的全部 outbox 行，不碰其它 entity', async () => {
  const { db, outbox, transactions } = createFakeDb();
  seed(outbox, { id: 'o1', entity_id: 'local:abc', status: 'failed' });
  seed(outbox, { id: 'o2', entity_id: 'local:abc', status: 'pending' });
  seed(outbox, { id: 'o3', entity_id: 'local:other', status: 'pending' });
  transactions.push({ scope_id: 'scope-a', id: 'local:abc', dirty: 1 });

  await dropOutboxItem(db, 'scope-a', item({ id: 'o1', entityId: 'local:abc' }));

  expect(outbox.map((row) => row.id)).toEqual(['o3']);
  expect(transactions).toHaveLength(0);
});

test('放弃服务端交易的本地改动：删除 outbox 行、保留交易并清 dirty', async () => {
  const { db, outbox, transactions } = createFakeDb();
  const row = seed(outbox, { id: 'o2', entity_id: '42' });
  transactions.push({ scope_id: 'scope-a', id: '42', dirty: 1 });

  await dropOutboxItem(db, 'scope-a', item({ id: row.id, entityId: '42' }));

  expect(outbox).toHaveLength(0);
  expect(transactions).toEqual([{ scope_id: 'scope-a', id: '42', dirty: 0 }]);
});

test('scope 不匹配时不误删其它账号的行', async () => {
  const { db, outbox, transactions } = createFakeDb();
  const row = seed(outbox, { id: 'o3', scope_id: 'scope-b', entity_id: 'local:xyz' });
  transactions.push({ scope_id: 'scope-b', id: 'local:xyz', dirty: 1 });

  await dropOutboxItem(db, 'scope-a', item({ id: row.id, entityId: 'local:xyz' }));

  expect(outbox).toHaveLength(1);
  expect(transactions).toHaveLength(1);
});
