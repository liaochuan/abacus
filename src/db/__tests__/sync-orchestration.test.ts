import type { AxiosInstance } from 'axios';

import {
  AuthExpiredError, mergeSyncResult, runSync, withAuthRetry,
} from '../sync';
import type { SyncContext, SyncResult } from '../sync';
import { pushCreate, pushUpdate } from '../syncPush';
import { pullTransactions } from '../syncPull';
import { pullBlobs } from '../syncBlobs';
import {
  getSyncState,
  isSyncRunning,
  runExclusively,
  setSyncState,
  subscribeSyncChanged,
} from '../syncState';
import type { Db } from '../types';

// 编排测试的关注点是「顺序、失败隔离、attempts 上限、cursor 推进、token 刷新」，
// 不重复验证 push / pull 的内部实现（它们各有独立测试）。因此这里把三条网络流水线
// 替换成 jest mock，只用真实代码跑 outbox 记账与 meta 读写：
// - fake Db 模拟 outbox / meta 两张表用到的 SQL，并拒绝任何不带 scope_id 的新语句；
// - fake ctx.http 一旦被调用就直接失败，用来证明编排层没有绕过流水线直接发请求。

// 真实模块里的 LocalWriteError 必须保留（sync.ts 用 instanceof 识别），
// 只把两条网络流水线替换成 jest mock。
jest.mock('../syncPush', () => ({
  ...jest.requireActual('../syncPush'),
  pushCreate: jest.fn(),
  pushUpdate: jest.fn(),
}));

jest.mock('../syncPull', () => ({
  pullTransactions: jest.fn(),
}));

jest.mock('../syncBlobs', () => ({
  pullBlobs: jest.fn(),
}));

const SCOPE = 'scope-a';

const pushCreateMock = pushCreate as jest.MockedFunction<typeof pushCreate>;
const pushUpdateMock = pushUpdate as jest.MockedFunction<typeof pushUpdate>;
const pullTransactionsMock = pullTransactions as jest.MockedFunction<typeof pullTransactions>;
const pullBlobsMock = pullBlobs as jest.MockedFunction<typeof pullBlobs>;

// ---------------------------------------------------------------------------
// fake Db：内存版 outbox + meta。

// 假表行必须镜像真实 SQL 列名（snake_case）：listOutbox 的映射函数按列名读取。
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
    groupTitle: 'g',
    transactions: [],
    user: '',
    createdAt: '',
    updatedAt: '',
  },
});

type OutboxSeed = {
  id: string;
  op?: 'create' | 'update';
  status?: string;
  attempts?: number;
  createdAt?: string;
};

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

// 已有仓储里两个只按主键定位的语句（outbox.id 是 uuid 主键），
// 它们没有 scope 条件；其余语句（含本任务新增的 recordOutboxAttempt）必须带 scope_id。
const BY_ID_ONLY = /^UPDATE outbox SET status = 'failed', attempts = attempts \+ 1, last_error = \? WHERE id = \?$/i;

const createFakeDb = (seed: OutboxSeed[] = []) => {
  const outbox: OutboxRow[] = seed.map((item, index) => ({
    scope_id: SCOPE,
    id: item.id,
    op: item.op ?? 'create',
    entity_id: `local:${index + 1}`,
    base_updated_at: null,
    payload: payloadJson,
    status: item.status ?? 'pending',
    attempts: item.attempts ?? 0,
    last_error: null,
    created_at: item.createdAt ?? `2026-10-0${index + 1}T00:00:00.000Z`,
  }));
  const meta = new Map<string, string | null>();
  const runLog: Array<{ sql: string; params: unknown[] }> = [];

  const check = (sql: string, params: unknown[]): string => {
    const s = normalize(sql);
    const marks = s.split('?').length - 1;
    if (marks !== params.length) {
      throw new Error(`placeholder/param mismatch (${marks} vs ${params.length}): ${s}`);
    }
    if (!BY_ID_ONLY.test(s)) {
      if (!/scope_id/i.test(s)) {
        throw new Error(`statement is not scoped: ${s}`);
      }
      if (!params.includes(SCOPE)) {
        throw new Error(`statement does not bind the current scope: ${s}`);
      }
    }
    return s;
  };

  const db: Db = {
    exec: async () => {},
    run: async (sql, params = []) => {
      runLog.push({ sql, params });
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
      if (BY_ID_ONLY.test(s)) {
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
        return outbox
          .filter((r) => r.scope_id === scopeId && r.status === status)
          .sort((a, b) => (a.created_at === b.created_at
            ? (a.id < b.id ? -1 : 1)
            : (a.created_at < b.created_at ? -1 : 1))) as unknown as T[];
      }
      throw new Error(`unexpected all sql: ${sql}`);
    },
    get: async <T>(): Promise<T | null> => {
      throw new Error('unexpected get');
    },
    tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };

  return {
    db, outbox, meta, runLog,
  };
};

// ---------------------------------------------------------------------------
// fake ctx.http：编排层不应直接触碰网络。

const createFakeHttp = () => {
  const calls: string[] = [];
  const fail = (name: string) => async (...args: unknown[]) => {
    calls.push(`${name}:${String(args[0])}`);
    throw new Error(`orchestration must not call http.${name} directly`);
  };
  const http = {
    get: fail('get'),
    post: fail('post'),
    put: fail('put'),
  } as unknown as AxiosInstance;
  return { http, calls };
};

const makeCtx = (overrides: Partial<SyncContext> = {}): SyncContext => {
  const { http } = createFakeHttp();
  return {
    backendURL: 'https://firefly.example',
    accessToken: 'token-a',
    http,
    range: { start: '2026-07-29', end: '2026-10-27' },
    currencyCode: 'CNY',
    displayAllAccounts: false,
    apiVersion: '6.0.0',
    refreshToken: jest.fn(async () => 'token-b'),
    ...overrides,
  };
};

// Firefly 风格的结构化错误：classifySyncError 只看 response.status / code。
const httpError = (status: number) => ({ response: { status } });
const networkError = () => Object.assign(new Error('network down'), { code: 'ERR_NETWORK' });

const emptyTally = (): SyncResult => ({
  pushed: 0, pulled: 0, deleted: 0, conflicts: 0, failed: 0,
});

beforeEach(() => {
  jest.clearAllMocks();
  pushCreateMock.mockResolvedValue('created');
  pushUpdateMock.mockResolvedValue('updated');
  pullTransactionsMock.mockResolvedValue({ pulled: 0, deleted: 0, complete: true });
  pullBlobsMock.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// mergeSyncResult

describe('mergeSyncResult', () => {
  test('同步结果逐字段累加', () => {
    const a: SyncResult = {
      pushed: 1, pulled: 2, deleted: 0, conflicts: 0, failed: 0,
    };
    const b: SyncResult = {
      pushed: 0, pulled: 1, deleted: 2, conflicts: 1, failed: 0,
    };
    expect(mergeSyncResult(a, b)).toEqual({
      pushed: 1, pulled: 3, deleted: 2, conflicts: 1, failed: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// 顺序

describe('runSync 顺序', () => {
  test('先按顺序 push 全部 pending 项，再 pull 交易，最后 pull blobs', async () => {
    const { db, outbox } = createFakeDb([
      { id: 'ob1', op: 'create', createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'ob2', op: 'update', createdAt: '2026-10-02T00:00:00.000Z' },
    ]);
    const events: string[] = [];

    pushCreateMock.mockImplementation(async (_db, _scopeId, _ctx, item) => {
      events.push(`push:${item.id}:${item.op}`);
      return 'created';
    });
    pushUpdateMock.mockImplementation(async (_db, _scopeId, _ctx, item) => {
      events.push(`push:${item.id}:${item.op}`);
      return 'conflict';
    });
    pullTransactionsMock.mockImplementation(async () => {
      events.push('pull');
      return { pulled: 3, deleted: 2, complete: true };
    });
    pullBlobsMock.mockImplementation(async () => {
      events.push('blobs');
      return 4;
    });

    const result = await runSync(db, SCOPE, makeCtx());

    expect(events).toEqual(['push:ob1:create', 'push:ob2:update', 'pull', 'blobs']);
    // 冲突项已推送成功，同时计入 conflicts。
    expect(result).toEqual({
      pushed: 2, pulled: 3, deleted: 2, conflicts: 1, failed: 0,
    });
    expect(outbox).toHaveLength(2); // mock 流水线不删行，行为以事件顺序为准
  });

  test('full 选项透传给 pullTransactions', async () => {
    const { db } = createFakeDb();
    await runSync(db, SCOPE, makeCtx(), { full: true });
    expect(pullTransactionsMock).toHaveBeenCalledWith(expect.anything(), SCOPE, expect.anything(), true);

    await runSync(db, SCOPE, makeCtx());
    expect(pullTransactionsMock).toHaveBeenLastCalledWith(expect.anything(), SCOPE, expect.anything(), false);
  });

  test('编排层不直接发请求', async () => {
    const { db } = createFakeDb([{ id: 'ob1' }]);
    const { http, calls } = createFakeHttp();
    await runSync(db, SCOPE, makeCtx({ http }));
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 失败隔离与 attempts

describe('push 失败处理', () => {
  test('单条失败不阻断后续项，且 attempts + 1 后保持 pending', async () => {
    const { db, outbox } = createFakeDb([
      { id: 'ob1', op: 'create', createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'ob2', op: 'create', createdAt: '2026-10-02T00:00:00.000Z' },
      { id: 'ob3', op: 'create', createdAt: '2026-10-03T00:00:00.000Z' },
    ]);
    pushCreateMock
      .mockResolvedValueOnce('created')
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce('created');

    const result = await runSync(db, SCOPE, makeCtx());

    expect(pushCreateMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ...emptyTally(), pushed: 2 });
    const failedItem = outbox.find((row) => row.id === 'ob2');
    expect(failedItem).toMatchObject({ status: 'pending', attempts: 1, last_error: 'network' });
    // 其余两项没有因为邻居失败而被记 attempts。
    expect(outbox.find((row) => row.id === 'ob1')?.attempts).toBe(0);
    expect(outbox.find((row) => row.id === 'ob3')?.attempts).toBe(0);
  });

  test('attempts 达到上限（5）时转为 failed 并计入 failed', async () => {
    const { db, outbox } = createFakeDb([
      { id: 'ob1', op: 'create', attempts: 4 },
      { id: 'ob2', op: 'create' },
    ]);
    pushCreateMock
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce('created');

    const result = await runSync(db, SCOPE, makeCtx());

    expect(result).toEqual({ ...emptyTally(), pushed: 1, failed: 1 });
    expect(outbox.find((row) => row.id === 'ob1')).toMatchObject({
      status: 'failed', attempts: 5, last_error: 'server',
    });
    expect(outbox.find((row) => row.id === 'ob2')?.attempts).toBe(0);
  });

  test('未达上限时只累加 attempts（4 次仍保持 pending）', async () => {
    const { db, outbox } = createFakeDb([{ id: 'ob1', attempts: 3 }]);
    pushCreateMock.mockRejectedValue(httpError(500));

    const result = await runSync(db, SCOPE, makeCtx());

    expect(result).toEqual({ ...emptyTally(), failed: 0 });
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 4, last_error: 'server' });
  });

  test('不可重试错误直接转 failed 并计入 failed', async () => {
    const { db, outbox } = createFakeDb([{ id: 'ob1' }]);
    pushCreateMock.mockRejectedValue(new Error('boom'));

    const result = await runSync(db, SCOPE, makeCtx());

    expect(result).toEqual({ ...emptyTally(), failed: 1 });
    expect(outbox[0]).toMatchObject({ status: 'failed', attempts: 1, last_error: 'other' });
  });

  test('流水线返回 failed 时计入 failed，不重复落库', async () => {
    const { db, outbox } = createFakeDb([{ id: 'ob1', op: 'update' }]);
    pushUpdateMock.mockResolvedValue('failed');

    const result = await runSync(db, SCOPE, makeCtx());

    expect(result).toEqual({ ...emptyTally(), failed: 1 });
    // pushUpdate 自己已经标记过 failed，编排层不应再改 attempts。
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
  });
});

// ---------------------------------------------------------------------------
// last_synced_at

describe('last_synced_at', () => {
  test('完整成功时写入 last_synced_at 并清空连接告警', async () => {
    const { db, meta } = createFakeDb([{ id: 'ob1' }]);
    meta.set('last_synced_at', '2026-10-01T00:00:00.000Z');
    meta.set('last_sync_error', 'network');
    meta.set('connection_alert_level', '3');
    meta.set('connection_alert_acknowledged_at', '2026-10-02T00:00:00.000Z');

    await runSync(db, SCOPE, makeCtx());

    expect(meta.get('last_synced_at')).not.toBe('2026-10-01T00:00:00.000Z');
    expect(meta.get('last_synced_at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.get('last_sync_error')).toBeNull();
    expect(meta.get('connection_alert_level')).toBeNull();
    expect(meta.get('connection_alert_acknowledged_at')).toBeNull();
  });

  test('确认过 7 档后干净同步把档位归零，下一次 3 天断网能重新提醒', async () => {
    const { db, meta } = createFakeDb();
    meta.set('connection_alert_level', '7');
    meta.set('connection_alert_acknowledged_at', '2026-10-01T00:00:00.000Z');

    await runSync(db, SCOPE, makeCtx());

    // 删除即读作 0：残留 7 会让下一次 3 > 7 为假，直到第 7 天才提醒。
    expect(meta.get('connection_alert_level')).toBeNull();
    expect(meta.get('connection_alert_acknowledged_at')).toBeNull();
  });

  test('拉取不完整时不推进 last_synced_at、不刷新 blob', async () => {
    const { db, meta } = createFakeDb([]);
    meta.set('last_synced_at', '2026-10-01T00:00:00.000Z');
    pullTransactionsMock.mockResolvedValue({ pulled: 2, deleted: 0, complete: false });

    const result = await runSync(db, SCOPE, makeCtx());

    expect(result).toEqual({ ...emptyTally(), pulled: 2 });
    expect(meta.get('last_synced_at')).toBe('2026-10-01T00:00:00.000Z');
    expect(meta.get('last_sync_error')).toBe('incomplete');
    expect(pullBlobsMock).not.toHaveBeenCalled();
  });

  test('有 failed 时仍推进 last_synced_at，但不清空连接告警', async () => {
    const { db, meta } = createFakeDb([{ id: 'ob1' }]);
    meta.set('last_synced_at', '2026-10-01T00:00:00.000Z');
    meta.set('connection_alert_level', '3');
    meta.set('connection_alert_acknowledged_at', '2026-10-02T00:00:00.000Z');
    // other 分类：直接转 failed，计入 result.failed
    pushCreateMock.mockRejectedValue(new Error('boom'));

    const result = await runSync(db, SCOPE, makeCtx());

    expect(result.failed).toBe(1);
    // 拉取成功 → last_synced_at 推进
    expect(meta.get('last_synced_at')).not.toBe('2026-10-01T00:00:00.000Z');
    expect(meta.get('last_synced_at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 还有待处理项 → 告警键与确认时间原样保留
    expect(meta.get('connection_alert_level')).toBe('3');
    expect(meta.get('connection_alert_acknowledged_at')).toBe('2026-10-02T00:00:00.000Z');
  });

  test('有 conflicts 时同样保留连接告警', async () => {
    const { db, meta } = createFakeDb([{ id: 'ob1', op: 'update' }]);
    meta.set('last_synced_at', '2026-10-01T00:00:00.000Z');
    meta.set('connection_alert_level', '2');
    meta.set('connection_alert_acknowledged_at', null);
    pushUpdateMock.mockResolvedValue('conflict');

    const result = await runSync(db, SCOPE, makeCtx());

    expect(result.conflicts).toBe(1);
    expect(meta.get('last_synced_at')).not.toBe('2026-10-01T00:00:00.000Z');
    expect(meta.get('connection_alert_level')).toBe('2');
  });

  test('拉取抛错时不推进 last_synced_at，记录错误分类并向上抛', async () => {
    const { db, meta } = createFakeDb([{ id: 'ob1' }]);
    meta.set('last_synced_at', '2026-10-01T00:00:00.000Z');
    pullTransactionsMock.mockRejectedValue(networkError());

    await expect(runSync(db, SCOPE, makeCtx())).rejects.toThrow('network down');

    expect(meta.get('last_synced_at')).toBe('2026-10-01T00:00:00.000Z');
    expect(meta.get('last_sync_error')).toBe('network');
    expect(pullBlobsMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// token 刷新

describe('withAuthRetry', () => {
  test('认证失败时刷新一次 token 并用新上下文重试', async () => {
    const ctx = makeCtx();
    const seen: string[] = [];
    const fn = jest.fn(async (active: SyncContext) => {
      seen.push(active.accessToken);
      if (seen.length === 1) {
        throw httpError(401);
      }
      return 'ok';
    });

    await expect(withAuthRetry(ctx, fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(ctx.refreshToken).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['token-a', 'token-b']);
    // 原上下文不被修改。
    expect(ctx.accessToken).toBe('token-a');
  });

  test('刷新后仍认证失败抛 AuthExpiredError（内容为固定短句）', async () => {
    const ctx = makeCtx();
    const fn = jest.fn(async () => {
      throw httpError(403);
    });

    const error = await withAuthRetry(ctx, fn).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AuthExpiredError);
    expect((error as Error).name).toBe('AuthExpiredError');
    expect((error as Error).message).toBe('sync requires re-authentication');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(ctx.refreshToken).toHaveBeenCalledTimes(1);
  });

  test('非认证错误不刷新、不重试', async () => {
    const ctx = makeCtx();
    const fn = jest.fn(async () => {
      throw httpError(500);
    });

    await expect(withAuthRetry(ctx, fn)).rejects.toMatchObject({ response: { status: 500 } });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(ctx.refreshToken).not.toHaveBeenCalled();
  });

  test('刷新本身网络失败时抛原刷新错误（按离线处理，不要求重新登录）', async () => {
    const ctx = makeCtx({
      refreshToken: jest.fn(async () => {
        throw networkError();
      }),
    });
    const fn = jest.fn(async () => {
      throw httpError(401);
    });

    await expect(withAuthRetry(ctx, fn)).rejects.toThrow('network down');
    expect(ctx.refreshToken).toHaveBeenCalledTimes(1);
  });

  test('刷新本身被服务端拒绝时抛 AuthExpiredError', async () => {
    const ctx = makeCtx({
      refreshToken: jest.fn(async () => {
        throw httpError(401);
      }),
    });
    const fn = jest.fn(async () => {
      throw httpError(401);
    });

    await expect(withAuthRetry(ctx, fn)).rejects.toBeInstanceOf(AuthExpiredError);
  });

  test('runSync 中 push 的认证失败会逃出 runSync，由 withAuthRetry 刷新后整轮重跑一次', async () => {
    const { db, meta } = createFakeDb([{ id: 'ob1' }]);
    pushCreateMock
      .mockRejectedValueOnce(httpError(401))
      .mockResolvedValueOnce('created');
    const ctx = makeCtx();

    const result = await runSync(db, SCOPE, ctx);

    // 第一次 push 抛 401 → 逃出推送循环与 runSync 的流水线 → withAuthRetry 刷新并重跑一次
    expect(pushCreateMock).toHaveBeenCalledTimes(2);
    expect(ctx.refreshToken).toHaveBeenCalledTimes(1);
    expect(result.pushed).toBe(1);
    expect(meta.get('last_synced_at')).not.toBeNull();
  });

  test('runSync 中刷新失败时把 auth 写入 last_sync_error 并抛 AuthExpiredError', async () => {
    const { db, meta } = createFakeDb([{ id: 'ob1' }]);
    pushCreateMock.mockRejectedValue(httpError(401));
    const ctx = makeCtx({
      refreshToken: jest.fn(async () => {
        throw httpError(400);
      }),
    });

    await expect(runSync(db, SCOPE, ctx)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(meta.get('last_sync_error')).toBe('auth');
    expect(meta.get('last_synced_at')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// syncState 原语

describe('syncState', () => {
  const idle = () => {
    setSyncState({
      kind: 'idle', lastSyncedAt: null, pending: 0, problems: 0,
    });
  };

  beforeEach(idle);

  test('emitSyncChanged 通知订阅者，取消订阅后不再通知', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeSyncChanged(listener);

    setSyncState({
      kind: 'syncing', phase: 'push',
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSyncState()).toEqual({ kind: 'syncing', phase: 'push' });

    unsubscribe();
    setSyncState({
      kind: 'offline', lastSyncedAt: null, pending: 1, problems: 0,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('单个订阅者抛错不影响其它订阅者', () => {
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    const offBad = subscribeSyncChanged(bad);
    const offGood = subscribeSyncChanged(good);

    expect(() => setSyncState({
      kind: 'idle', lastSyncedAt: null, pending: 0, problems: 0,
    })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);

    offBad();
    offGood();
  });

  test('runExclusively 并发调用复用同一轮任务', async () => {
    expect(isSyncRunning()).toBe(false);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;

    const first = runExclusively(async () => {
      runs += 1;
      await gate;
    });
    expect(isSyncRunning()).toBe(true);

    const second = runExclusively(async () => {
      runs += 1;
    });
    expect(second).toBe(first);

    release();
    await first;
    expect(runs).toBe(1);
    expect(isSyncRunning()).toBe(false);
  });

  test('任务抛错后锁仍会释放', async () => {
    await expect(runExclusively(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(isSyncRunning()).toBe(false);

    await runExclusively(async () => {});
    expect(isSyncRunning()).toBe(false);
  });
});
