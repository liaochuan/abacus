import type { AxiosInstance } from 'axios';

import { runSync } from '../sync';
import type { SyncContext } from '../sync';
import { LocalWriteError } from '../syncPush';
import { bindServerId, markOutboxFailed } from '../outbox';
import { pullTransactions } from '../syncPull';
import { pullBlobs } from '../syncBlobs';
import type { Db } from '../types';

// 这条不变量只能用「真实的 pushCreate + 真实的 runSync」来验证：
// - 真实 pushCreate 负责在 POST 2xx 之后把本地写库失败包装成 LocalWriteError；
// - 真实 runSync 负责识别该类型、只累加 attempts 并保持 pending。
// 因此这里只 mock 两处：
// 1) outbox.bindServerId 直接抛库错误（模拟 2xx 之后写库失败），markOutboxFailed 包一层 jest.fn
//    以便断言「从未被调用」，其余 outbox / repository 函数保持真实实现；
// 2) pull / blobs 用空实现，避免与本测试无关的网络路径干扰。

jest.mock('../syncPull', () => ({
  pullTransactions: jest.fn(),
}));

jest.mock('../syncBlobs', () => ({
  pullBlobs: jest.fn(),
}));

jest.mock('../outbox', () => {
  const actual = jest.requireActual('../outbox');
  return {
    ...actual,
    bindServerId: jest.fn(async () => {
      throw new Error('disk I/O error');
    }),
    markOutboxFailed: jest.fn(actual.markOutboxFailed),
  };
});

const pullTransactionsMock = pullTransactions as unknown as jest.Mock;
const pullBlobsMock = pullBlobs as unknown as jest.Mock;

const SCOPE = 'scope-a';

const bindServerIdMock = bindServerId as jest.MockedFunction<typeof bindServerId>;
const markOutboxFailedMock = markOutboxFailed as jest.MockedFunction<typeof markOutboxFailed>;

/* eslint-disable camelcase */
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
/* eslint-enable camelcase */

const payloadJson = JSON.stringify({
  id: 'local:1',
  type: 'transactions',
  attributes: {
    groupTitle: 'Groceries',
    transactions: [{
      description: 'coffee',
      amount: '3.50',
      date: '2026-10-01T00:00:00Z',
      type: 'withdrawal',
      sourceName: 'Cash',
      destinationName: 'Shop',
      categoryName: 'Food',
      budgetName: '',
      billName: '',
      tags: [],
      notes: '',
      foreignAmount: '',
    }],
    user: '',
    createdAt: '',
    updatedAt: '',
  },
});

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

// 只实现本路径会走到的语句：listOutbox、recordOutboxAttempt、markOutboxFailed、setMeta。
// 未识别的语句直接抛错，防止实现漂移被静默放过。
const createFakeDb = () => {
  const outbox: OutboxRow[] = [{
    scope_id: SCOPE,
    id: 'ob1',
    op: 'create',
    entity_id: 'local:1',
    base_updated_at: null,
    payload: payloadJson,
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: '2026-10-01T00:00:00Z',
  }];
  const meta = new Map<string, string | null>();

  const check = (sql: string, params: unknown[]): string => {
    const s = normalize(sql);
    const marks = s.split('?').length - 1;
    if (marks !== params.length) {
      throw new Error(`placeholder/param mismatch (${marks} vs ${params.length}): ${s}`);
    }
    return s;
  };

  const db: Db = {
    exec: async () => {},
    run: async (sql, params = []) => {
      const s = check(sql, params);

      if (/^UPDATE outbox SET attempts = attempts \+ 1, last_error = \? WHERE scope_id = \? AND id = \?$/i.test(s)) {
        const [error, scopeId, id] = params as [string, string, string];
        const row = outbox.find((r) => r.scope_id === scopeId && r.id === id);
        if (row) {
          row.attempts += 1;
          row.last_error = error;
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
      if (/^INSERT OR REPLACE INTO meta \(scope_id, key, value\) VALUES \(\?, \?, \?\)$/i.test(s)) {
        const [scopeId, key, value] = params as [string, string, string | null];
        if (scopeId === SCOPE) {
          meta.set(key, value);
        }
        return;
      }
      throw new Error(`unexpected run sql: ${sql}`);
    },
    all: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const s = check(sql, params);
      if (/^SELECT \* FROM outbox WHERE scope_id = \? AND status = \? ORDER BY created_at ASC, id ASC$/i.test(s)) {
        const [scopeId, status] = params as [string, string];
        return outbox.filter((r) => r.scope_id === scopeId && r.status === status) as unknown as T[];
      }
      throw new Error(`unexpected all sql: ${sql}`);
    },
    get: async <T>(): Promise<T | null> => {
      throw new Error('unexpected get');
    },
    tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };

  return { db, outbox, meta };
};

// 对账 GET 返回空列表 → 直接 POST；POST 返回 2xx（服务端已接受）。
const createFakeHttp = () => {
  const lines: string[] = [];
  const http = {
    get: jest.fn(async () => {
      lines.push('get');
      return { data: { data: [] } };
    }),
    post: jest.fn(async () => {
      lines.push('post');
      return {
        data: {
          data: {
            id: '42',
            type: 'transactions',
            attributes: {
              groupTitle: 'Groceries',
              transactions: [{ updatedAt: '2026-10-02T00:00:00Z' }],
              user: '',
              createdAt: '',
              updatedAt: '2026-10-02T00:00:00Z',
            },
          },
        },
      };
    }),
  } as unknown as AxiosInstance;
  return { http, lines };
};

const makeCtx = (http: AxiosInstance): SyncContext => ({
  backendURL: 'https://firefly.example',
  accessToken: 'token-a',
  http,
  range: { start: '2026-07-29', end: '2026-10-27' },
  currencyCode: 'CNY',
  displayAllAccounts: false,
  apiVersion: '6.0.0',
  refreshToken: jest.fn(async () => 'token-b'),
});

describe('POST 2xx 之后本地写库失败', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    bindServerIdMock.mockImplementation(async () => {
      throw new Error('disk I/O error');
    });
    pullTransactionsMock.mockResolvedValue({ pulled: 0, deleted: 0, complete: true });
    pullBlobsMock.mockResolvedValue(0);
  });

  test('outbox 行保持 pending、attempts + 1，且 markOutboxFailed 未被调用', async () => {
    const { db, outbox, meta } = createFakeDb();
    const { http, lines } = createFakeHttp();

    const result = await runSync(db, SCOPE, makeCtx(http));

    // 真实 pushCreate 确实发出了对账 GET + POST，并在 2xx 后尝试绑定
    expect(lines).toEqual(['get', 'post']);
    expect(bindServerIdMock).toHaveBeenCalledTimes(1);

    // 行仍在队列里：状态 pending、attempts 累加、last_error 记录固定分类串
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'local-write',
    });

    // 关键不变量：绝不标 failed
    expect(markOutboxFailedMock).not.toHaveBeenCalled();

    // 本轮计入 failed，但同步整体仍完成（pull/blobs 照常跑、last_synced_at 推进）
    expect(result.failed).toBe(1);
    expect(result.pushed).toBe(0);
    expect(meta.get('last_synced_at')).not.toBeUndefined();
  });

  test('LocalWriteError 消息为固定短句且保留 cause', () => {
    const cause = new Error('disk I/O error');
    const error = new LocalWriteError(cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LocalWriteError');
    expect(error.message).toBe('local write failed after server accepted the change');
    expect((error as { cause?: unknown }).cause).toBe(cause);
  });
});
