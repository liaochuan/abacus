import type { AxiosInstance } from 'axios';
import { buildSearchUrl, fetchAllTransactions, pullTransactions } from '../syncPull';
import type { Db } from '../types';

// pull 的两层测试都不碰网络与真实 SQLite：
// - fetchAllTransactions 用 fake ctx.http 提供分页负载；
// - pullTransactions 用 fake Db 模拟 repository 实际会执行的 SQL 形态，
//   这样脏行保护、seen 集合对账、notices 落库都是真跑一遍，而不是 mock 掉。

const SCOPE = 'scope-a';

// ---------------------------------------------------------------------------
// fake ctx.http：按 page 返回预设响应。

type FakePage = {
  data?: unknown;
  totalPages?: number;
  // 省略时按单页响应（totalPages = 1）返回。
};

const createFakeHttp = (pages: Record<number, FakePage | Error>) => {
  const calls: string[] = [];
  const get = async (url: string): Promise<unknown> => {
    calls.push(url);
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1');
    const entry = pages[page];
    if (entry instanceof Error) {
      throw entry;
    }
    return {
      data: {
        data: entry?.data ?? [],
        meta: {
          pagination: {
            currentPage: page,
            totalPages: entry?.totalPages ?? 1,
          },
        },
      },
    };
  };
  return { http: { get } as unknown as AxiosInstance, calls };
};

// Firefly 原始组是 snake_case；本地一律 camelCase。用 snake_case 构造夹具，
// 才能验证 fetch 阶段确实做了归一化。
const group = (id: string, date = '2026-10-01') => ({
  id,
  type: 'transactions',
  attributes: {
    group_title: `group ${id}`,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    transactions: [
      {
        description: `desc ${id}`,
        amount: '12.50',
        date,
        type: 'withdrawal',
        source_name: 'Source',
        destination_name: 'Target',
        updated_at: '2026-10-02T00:00:00Z',
      },
    ],
  },
});

const WINDOW = { start: '2026-07-29', end: '2026-10-27' };
const URL_PREFIX = 'https://ff/api/v1/search/transactions?limit=50';

// ---------------------------------------------------------------------------
// fake Db：内存版 SQLite，只认 pull 路径会用到的语句形态。
// 任何未识别的语句、未带 scope_id 的语句、或首个参数不是 scope_id 的调用都直接抛错，
// 用来固定「所有语句都按 scope 过滤」这条硬规则。

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

const createFakeDb = (seed: TxRow[]) => {
  const transactions: TxRow[] = seed.map((row) => ({ ...row }));
  const notices: NoticeRow[] = [];
  const runLog: Array<{ sql: string; params: unknown[] }> = [];

  const begin = (sql: string, params: unknown[]) => {
    const s = normalize(sql);
    const marks = s.split('?').length - 1;
    if (marks !== params.length) {
      throw new Error(`placeholder/param mismatch (${marks} vs ${params.length}): ${s}`);
    }
    if (!/scope_id/i.test(s)) {
      throw new Error(`statement is not scoped: ${s}`);
    }
    if (params[0] !== SCOPE) {
      throw new Error(`scope_id is not the first bound parameter: ${s}`);
    }
    return s;
  };

  const db: Db = {
    exec: async () => {},
    run: async (sql, params = []) => {
      runLog.push({ sql, params });
      const s = begin(sql, params);

      if (/^INSERT INTO transactions/i.test(s)) {
        const [scopeId, id, payload, occurredAt, serverUpdatedAt] = params as [
          string, string, string, string, string | null,
        ];
        const row = transactions.find((r) => r.scope_id === scopeId && r.id === id);
        if (row) {
          row.payload = payload;
          row.occurred_at = occurredAt;
          row.server_updated_at = serverUpdatedAt;
          row.dirty = 0;
          return;
        }
        transactions.push({
          scope_id: scopeId,
          id,
          payload,
          occurred_at: occurredAt,
          server_updated_at: serverUpdatedAt,
          dirty: 0,
        });
        return;
      }

      if (/^INSERT INTO notices .*VALUES \(\?, \?, 'server_deletion', \?, NULL, \?, \?, NULL\)$/i.test(s)) {
        // 语句里 kind / local_payload / acknowledged_at 是字面量，只有 5 个绑定参数。
        const [scopeId, id, entityId, serverPayload, detectedAt] = params as [
          string, string, string, string, string,
        ];
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

      if (/^DELETE FROM transactions WHERE scope_id = \? AND id = \?$/i.test(s)) {
        const [scopeId, id] = params as [string, string];
        const index = transactions.findIndex((r) => r.scope_id === scopeId && r.id === id);
        if (index >= 0) {
          transactions.splice(index, 1);
        }
        return;
      }

      throw new Error(`unexpected run sql: ${s}`);
    },
    all: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const s = begin(sql, params);

      if (/^SELECT id, payload FROM transactions WHERE scope_id = \? AND dirty = 0$/i.test(s)) {
        const [scopeId] = params as [string];
        return transactions
          .filter((r) => r.scope_id === scopeId && r.dirty === 0)
          .map((r) => ({ id: r.id, payload: r.payload })) as unknown as T[];
      }

      if (/^SELECT id FROM transactions WHERE scope_id = \? AND \(substr\(occurred_at, 1, 10\) <= \? OR substr\(occurred_at, 1, 10\) >= \?\)$/i.test(s)) {
        const [scopeId, start, end] = params as [string, string, string];
        return transactions
          .filter((r) => r.scope_id === scopeId
            && (r.occurred_at.slice(0, 10) <= start || r.occurred_at.slice(0, 10) >= end))
          .map((r) => ({ id: r.id })) as unknown as T[];
      }

      throw new Error(`unexpected all sql: ${s}`);
    },
    get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = begin(sql, params);

      if (/^SELECT dirty FROM transactions WHERE scope_id = \? AND id = \?$/i.test(s)) {
        const [scopeId, id] = params as [string, string];
        const row = transactions.find((r) => r.scope_id === scopeId && r.id === id);
        return (row ? { dirty: row.dirty } : null) as unknown as T | null;
      }

      throw new Error(`unexpected get sql: ${s}`);
    },
    tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };

  return {
    db, transactions, notices, runLog,
  };
};

const localRow = (id: string, overrides: Partial<TxRow> = {}): TxRow => ({
  scope_id: SCOPE,
  id,
  payload: JSON.stringify({
    id,
    type: 'transactions',
    attributes: {
      groupTitle: `local ${id}`,
      transactions: [{
        description: `local desc ${id}`,
        amount: '1.00',
        date: '2026-10-01',
        type: 'withdrawal',
        sourceName: 'LocalSource',
        destinationName: 'LocalTarget',
        updatedAt: '2026-09-30T00:00:00Z',
      }],
    },
  }),
  occurred_at: '2026-10-01',
  server_updated_at: '2026-09-30T00:00:00Z',
  dirty: 0,
  ...overrides,
});

beforeEach(() => {
  // 固定「现在」，让窗口边界与断言都不依赖运行测试的日期/时区。
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 9, 27, 12, 0, 0));
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('buildSearchUrl', () => {
  test('搜索 URL 带日期窗口与分页', () => {
    const url = buildSearchUrl('https://ff', { start: '2026-07-29', end: '2026-10-27' }, 2, 50);
    expect(url).toBe(
      'https://ff/api/v1/search/transactions?limit=50&page=2&query=date_after%3A2026-07-29%20date_before%3A2026-10-27',
    );
  });
});

describe('fetchAllTransactions', () => {
  test('按 totalPages 翻完所有页并归一化为 camelCase', async () => {
    const { http, calls } = createFakeHttp({
      1: { totalPages: 3, data: [group('1'), group('2')] },
      2: { totalPages: 3, data: [group('3'), group('4')] },
      3: { totalPages: 3, data: [group('5')] },
    });

    const items = await fetchAllTransactions({ backendURL: 'https://ff', http }, WINDOW);

    expect(items.map((item) => item.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(calls).toEqual([
      `${URL_PREFIX}&page=1&query=date_after%3A2026-07-29%20date_before%3A2026-10-27`,
      `${URL_PREFIX}&page=2&query=date_after%3A2026-07-29%20date_before%3A2026-10-27`,
      `${URL_PREFIX}&page=3&query=date_after%3A2026-07-29%20date_before%3A2026-10-27`,
    ]);

    const first = items[0];
    expect(first.attributes.groupTitle).toBe('group 1');
    expect(first.attributes.transactions[0].sourceName).toBe('Source');
    // split 级的 updated_at 不在本地 TransactionSplitType 声明里，但 repository 会读它当基线。
    const split = first.attributes.transactions[0] as unknown as Record<string, unknown>;
    expect(split.updatedAt).toBe('2026-10-02T00:00:00Z');
    expect((first.attributes as Record<string, unknown>).group_title).toBeUndefined();
  });

  test('遇到空页提前停止，不再请求后续页', async () => {
    const { http, calls } = createFakeHttp({
      1: { totalPages: 3, data: [group('1')] },
      2: { totalPages: 3, data: [] },
    });

    const items = await fetchAllTransactions({ backendURL: 'https://ff', http }, WINDOW);

    expect(items.map((item) => item.id)).toEqual(['1']);
    expect(calls).toHaveLength(2);
  });

  test('任一页失败时向上抛错', async () => {
    const failure = new Error('Network Error');
    const { http, calls } = createFakeHttp({
      1: { totalPages: 2, data: [group('1')] },
      2: failure,
    });

    await expect(fetchAllTransactions({ backendURL: 'https://ff', http }, WINDOW))
      .rejects.toBe(failure);
    expect(calls).toHaveLength(2);
  });

  test('响应缺少 data 数组时抛错而不是当成空页', async () => {
    const http = {
      get: async () => ({ data: { meta: { pagination: { totalPages: 1 } } } }),
    } as unknown as AxiosInstance;

    await expect(fetchAllTransactions({ backendURL: 'https://ff', http }, WINDOW))
      .rejects.toThrow('transaction search response missing data');
  });

  test('服务端用 snake_case 的 total_pages 时同样翻页', async () => {
    const http = {
      get: async (url: string) => {
        const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1');
        return {
          data: {
            data: page === 1 ? [group('1')] : [],
            meta: { pagination: { current_page: page, total_pages: 1 } },
          },
        };
      },
    } as unknown as AxiosInstance;

    const items = await fetchAllTransactions({ backendURL: 'https://ff', http }, WINDOW);

    expect(items.map((item) => item.id)).toEqual(['1']);
  });
});

describe('pullTransactions', () => {
  test('完整拉取：脏行保留、远端覆盖、缺失项写删除通知', async () => {
    const seeded = [
      localRow('1'),
      localRow('2'),
      localRow('3', { dirty: 1 }),
      localRow('outside', { occurred_at: '2025-01-01' }),
    ];
    const { db, transactions, notices } = createFakeDb(seeded);
    const { http, calls } = createFakeHttp({
      1: { totalPages: 1, data: [group('1', '2026-10-05'), group('3'), group('4')] },
    });

    const result = await pullTransactions(db, SCOPE, { backendURL: 'https://ff', http }, true);

    expect(result).toEqual({ pulled: 3, deleted: 1, complete: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('date_after%3A2025-10-27');

    // 远端覆盖：payload 换成服务端版本，基线取组级 updated_at，dirty 归零。
    const updated = transactions.find((row) => row.id === '1');
    expect(JSON.parse(updated?.payload ?? '{}').attributes.groupTitle).toBe('group 1');
    expect(updated?.occurred_at).toBe('2026-10-05');
    expect(updated?.server_updated_at).toBe('2026-10-02T00:00:00Z');
    expect(updated?.dirty).toBe(0);

    // 新出现的 id 落库。
    expect(transactions.some((row) => row.id === '4')).toBe(true);

    // dirty = 1 的本地改动不被远端覆盖。
    const dirtyRow = transactions.find((row) => row.id === '3');
    expect(dirtyRow?.dirty).toBe(1);
    expect(JSON.parse(dirtyRow?.payload ?? '{}').attributes.groupTitle).toBe('local 3');

    // 窗口之外的历史行不参与对账，保留原样。
    expect(transactions.some((row) => row.id === 'outside')).toBe(true);

    // 未出现在完整拉取结果中的行：写 server_deletion 通知后删除。
    expect(transactions.some((row) => row.id === '2')).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      scope_id: SCOPE,
      kind: 'server_deletion',
      entity_id: '2',
      local_payload: null,
      acknowledged_at: null,
    });
    expect(JSON.parse(notices[0].server_payload).attributes.groupTitle).toBe('local 2');
  });

  test('分页中途失败：向上抛错且不做任何写入/删除', async () => {
    const seeded = [localRow('1'), localRow('2')];
    const {
      db, transactions, notices, runLog,
    } = createFakeDb(seeded);
    const failure = new Error('Network Error');
    const { http } = createFakeHttp({
      1: { totalPages: 2, data: [group('1')] },
      2: failure,
    });

    await expect(pullTransactions(db, SCOPE, { backendURL: 'https://ff', http }, false))
      .rejects.toBe(failure);

    expect(runLog).toHaveLength(0);
    expect(transactions.map((row) => row.id)).toEqual(['1', '2']);
    expect(notices).toHaveLength(0);
  });

  test('提前遇到空页（拉取不完整）：照常 upsert，但不做删除对账', async () => {
    const seeded = [localRow('2')];
    const { db, transactions, notices } = createFakeDb(seeded);
    const { http } = createFakeHttp({
      1: { totalPages: 2, data: [group('1')] },
      2: { totalPages: 2, data: [] },
    });

    const result = await pullTransactions(db, SCOPE, { backendURL: 'https://ff', http }, false);

    expect(result).toEqual({ pulled: 1, deleted: 0, complete: false });
    expect(transactions.map((row) => row.id).sort()).toEqual(['1', '2']);
    expect(notices).toHaveLength(0);
  });

  test('未来日期的本地行（晚于窗口末尾）不被当成服务端已删除', async () => {
    const seeded = [
      localRow('1', { occurred_at: '2026-10-01' }),
      localRow('future', { occurred_at: '2027-03-01' }),
    ];
    const { db, transactions, notices } = createFakeDb(seeded);
    const { http } = createFakeHttp({ 1: { totalPages: 1, data: [group('1')] } });

    const result = await pullTransactions(db, SCOPE, { backendURL: 'https://ff', http }, false);

    // 只有窗口内的 '1' 被服务端确认，'future' 超出 window.end 属于窗口之外。
    expect(result).toEqual({ pulled: 1, deleted: 0, complete: true });
    expect(transactions.map((row) => row.id).sort()).toEqual(['1', 'future']);
    expect(notices).toHaveLength(0);
  });

  test('响应缺少 meta.pagination 且首页满页：继续翻页且不做删除对账', async () => {
    const seeded = [localRow('2', { occurred_at: '2026-10-01' })];
    const { db, transactions, notices } = createFakeDb(seeded);
    const fullPage = Array.from({ length: 50 }, (_, index) => group(`s${index}`));
    const calls: string[] = [];
    const http = {
      get: async (url: string) => {
        calls.push(url);
        const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1');
        // 没有任何 meta.pagination：总页数不可知。
        return { data: { data: page === 1 ? fullPage : [] } };
      },
    } as unknown as AxiosInstance;

    const result = await pullTransactions(db, SCOPE, { backendURL: 'https://ff', http }, false);

    expect(calls.length).toBeGreaterThan(1);
    expect(result).toEqual({ pulled: 50, deleted: 0, complete: false });
    expect(transactions.some((row) => row.id === '2')).toBe(true);
    expect(notices).toHaveLength(0);
  });

  test('总页数超过翻页上限：停止请求并标记不完整', async () => {
    const { db, transactions, notices } = createFakeDb([localRow('2', { occurred_at: '2026-10-01' })]);
    const calls: string[] = [];
    const http = {
      get: async (url: string) => {
        calls.push(url);
        const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1');
        return {
          data: {
            data: [group(`p${page}`)],
            meta: { pagination: { currentPage: page, totalPages: 500 } },
          },
        };
      },
    } as unknown as AxiosInstance;

    const result = await pullTransactions(db, SCOPE, { backendURL: 'https://ff', http }, false);

    expect(calls).toHaveLength(200);
    expect(result).toEqual({ pulled: 200, deleted: 0, complete: false });
    expect(transactions.some((row) => row.id === '2')).toBe(true);
    expect(notices).toHaveLength(0);
  });

  test('缺 id 的组说明响应不可信：丢弃该组且不做删除对账', async () => {
    const seeded = [localRow('2')];
    const { db, transactions, notices } = createFakeDb(seeded);
    const broken: Record<string, unknown> = group('9');
    delete broken.id;
    const { http } = createFakeHttp({ 1: { totalPages: 1, data: [group('1'), broken] } });

    const result = await pullTransactions(db, SCOPE, { backendURL: 'https://ff', http }, false);

    expect(result).toEqual({ pulled: 1, deleted: 0, complete: false });
    expect(transactions.some((row) => row.id === '1')).toBe(true);
    expect(transactions.some((row) => row.id === '2')).toBe(true);
    expect(notices).toHaveLength(0);
  });

  test('增量窗口 90 天，完整同步 365 天', async () => {
    const incremental = createFakeHttp({ 1: { totalPages: 1, data: [] } });
    const incrementalDb = createFakeDb([]);
    await pullTransactions(
      incrementalDb.db,
      SCOPE,
      { backendURL: 'https://ff', http: incremental.http },
      false,
    );
    expect(incremental.calls[0]).toContain(
      'query=date_after%3A2026-07-29%20date_before%3A2026-10-27',
    );

    const full = createFakeHttp({ 1: { totalPages: 1, data: [] } });
    const fullDb = createFakeDb([]);
    await pullTransactions(
      fullDb.db,
      SCOPE,
      { backendURL: 'https://ff', http: full.http },
      true,
    );
    expect(full.calls[0]).toContain(
      'query=date_after%3A2025-10-27%20date_before%3A2026-10-27',
    );
  });

  test('服务端确实为空：窗口内本地行全部按删除处理', async () => {
    const seeded = [localRow('1', { occurred_at: '2026-10-01' })];
    const { db, transactions, notices } = createFakeDb(seeded);
    const { http } = createFakeHttp({ 1: { totalPages: 1, data: [] } });

    const result = await pullTransactions(db, SCOPE, { backendURL: 'https://ff', http }, false);

    expect(result).toEqual({ pulled: 0, deleted: 1, complete: true });
    expect(transactions).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0].entity_id).toBe('1');
  });
});
