import { act, renderHook, waitFor } from '@testing-library/react-native';

import { readSyncSummary, summarize, useSyncSummary } from '../useSyncSummary';
import { useBlob } from '../useBlob';
import { setDb } from '../instance';
import { emitSyncChanged } from '../syncState';
import type { Db } from '../types';

// 网络模块在真正的实现里会初始化 NetInfo（原生模块），测试里换成可控的开关：
// isOnline / subscribeNetwork 都只看 mockOnline 与 mockNetworkListeners，
// 这样「网络恢复后重新读摘要」的分支可以被确定性地触发。
let mockOnline = true;
const mockNetworkListeners = new Set<(online: boolean) => void>();

jest.mock('../../lib/network', () => ({
  isOnline: () => mockOnline,
  subscribeNetwork: (cb: (online: boolean) => void) => {
    mockNetworkListeners.add(cb);
    return () => {
      mockNetworkListeners.delete(cb);
    };
  },
}));

const SCOPE = 'scope-a';
const OTHER_SCOPE = 'scope-b';

type OutboxRow = {
  scope_id: string;
  status: string;
};

type NoticeRow = {
  scope_id: string;
  acknowledged_at: string | null;
};

type MetaRow = {
  scope_id: string;
  key: string;
  value: string | null;
};

type BlobRow = {
  scope_id: string;
  key: string;
  payload: string;
  fetched_at: string;
};

type FakeState = {
  outbox: OutboxRow[];
  notices: NoticeRow[];
  meta: MetaRow[];
  blobs: BlobRow[];
};

const emptyState = (): FakeState => ({
  outbox: [],
  notices: [],
  meta: [],
  blobs: [],
});

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

// 假 Db 按真实查询的语义从内存行里取数，同时对每条语句做两项硬检查：
// 1. 占位符数量与参数数量一致；
// 2. 涉及作用域表的语句必须带 `scope_id = ?` 且绑定当前 scope——
//    任何漏掉 scope 过滤的新语句都会让测试直接失败，而不是悄悄读到别的账号的数据。
const createFakeDb = (state: FakeState, gate?: Promise<void>): Db & { queries: string[] } => {
  const queries: string[] = [];

  const check = (sql: string, params: unknown[]): string => {
    const s = normalize(sql);
    const marks = s.split('?').length - 1;
    if (marks !== params.length) {
      throw new Error(`placeholder/param mismatch (${marks} vs ${params.length}): ${s}`);
    }
    if (/FROM (outbox|notices|meta|blobs)/i.test(s)) {
      if (!/scope_id = \?/i.test(s)) {
        throw new Error(`statement is not scoped: ${s}`);
      }
      if (params.includes(OTHER_SCOPE)) {
        throw new Error(`statement binds a foreign scope: ${s}`);
      }
    }
    queries.push(s);
    return s;
  };

  return {
    queries,
    exec: async () => {},
    run: async (sql, params = []) => {
      check(sql, params);
      throw new Error(`unexpected run in a read-only test: ${normalize(sql)}`);
    },
    tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    all: async (sql, params = []) => {
      check(sql, params);
      return [] as never[];
    },
    get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      // 需要固定「首次读取尚未完成」这一帧时，用 gate 把读库挂起。
      if (gate) {
        await gate;
      }
      const s = check(sql, params);
      const scopeId = params[0] as string;

      if (/FROM outbox/i.test(s)) {
        const rows = state.outbox.filter((row) => row.scope_id === scopeId);
        return {
          pending: rows.filter((row) => row.status === 'pending').length,
          failed: rows.filter((row) => row.status === 'failed').length,
        } as T;
      }

      if (/FROM notices/i.test(s)) {
        return {
          count: state.notices.filter(
            (row) => row.scope_id === scopeId && row.acknowledged_at === null,
          ).length,
        } as T;
      }

      if (/FROM meta/i.test(s)) {
        const [, key] = params as [string, string];
        const row = state.meta.find((item) => item.scope_id === scopeId && item.key === key);
        return (row ? { value: row.value } : null) as T | null;
      }

      if (/FROM blobs/i.test(s)) {
        const [, key] = params as [string, string];
        const row = state.blobs.find((item) => item.scope_id === scopeId && item.key === key);
        return (row ? { payload: row.payload, fetchedAt: row.fetched_at } : null) as T | null;
      }

      throw new Error(`unexpected get: ${s}`);
    },
  };
};

beforeEach(() => {
  mockOnline = true;
  mockNetworkListeners.clear();
});

test('problems 统计未确认提示与失败项', () => {
  expect(summarize({
    online: true,
    pending: 2,
    failedOutbox: 1,
    unacknowledgedNotices: 3,
    lastSyncedAt: 't',
  })).toEqual({
    online: true, pending: 2, problems: 4, lastSyncedAt: 't',
  });
});

test('problems 为 0 时保留 online 与 lastSyncedAt', () => {
  expect(summarize({
    online: false,
    pending: 0,
    failedOutbox: 0,
    unacknowledgedNotices: 0,
    lastSyncedAt: null,
  })).toEqual({
    online: false, pending: 0, problems: 0, lastSyncedAt: null,
  });
});

test('readSyncSummary 只统计当前 scope 的 pending/failed 与未确认提示', async () => {
  const db = createFakeDb({
    ...emptyState(),
    outbox: [
      { scope_id: SCOPE, status: 'pending' },
      { scope_id: SCOPE, status: 'pending' },
      { scope_id: SCOPE, status: 'failed' },
      // 这两个不计入：sent 已经推送成功，conflict 由 notices 表达。
      { scope_id: SCOPE, status: 'sent' },
      { scope_id: SCOPE, status: 'conflict' },
      // 别的账号的数据绝不能渗进来。
      { scope_id: OTHER_SCOPE, status: 'pending' },
      { scope_id: OTHER_SCOPE, status: 'failed' },
    ],
    notices: [
      { scope_id: SCOPE, acknowledged_at: null },
      { scope_id: SCOPE, acknowledged_at: null },
      { scope_id: SCOPE, acknowledged_at: null },
      { scope_id: SCOPE, acknowledged_at: '2026-10-27T00:00:00.000Z' },
      { scope_id: OTHER_SCOPE, acknowledged_at: null },
    ],
    meta: [
      { scope_id: SCOPE, key: 'last_synced_at', value: '2026-10-28T09:00:00.000Z' },
      { scope_id: OTHER_SCOPE, key: 'last_synced_at', value: '2026-10-01T00:00:00.000Z' },
    ],
  });
  setDb(db);

  await expect(readSyncSummary(db, SCOPE, true)).resolves.toEqual({
    online: true,
    pending: 2,
    problems: 4,
    lastSyncedAt: '2026-10-28T09:00:00.000Z',
  });

  const sql = db.queries.join('\n');
  expect(sql).toMatch(/status = 'pending'/);
  expect(sql).toMatch(/status = 'failed'/);
  expect(sql).toMatch(/acknowledged_at IS NULL/);
  expect(sql).toContain('scope_id = ?');
});

test('readSyncSummary 在 scope 为空时直接返回空摘要，不查库', async () => {
  const db = createFakeDb(emptyState());
  setDb(db);

  await expect(readSyncSummary(db, '', false)).resolves.toEqual({
    online: false, pending: 0, problems: 0, lastSyncedAt: null,
  });
  expect(db.queries).toHaveLength(0);
});

test('useSyncSummary 先返回默认值，再读库并随 sync 事件刷新', async () => {
  const state = emptyState();
  state.meta.push({ scope_id: '_global', key: 'current_scope', value: SCOPE });
  state.meta.push({ scope_id: SCOPE, key: 'last_synced_at', value: '2026-10-28T09:00:00.000Z' });
  state.outbox.push({ scope_id: SCOPE, status: 'pending' });

  // 用 gate 把首次读库挂起，固定「加载中那一帧」再断言默认值；
  // 否则 fake Db 的 Promise 可能在 renderHook 返回前就 resolve，默认值被直接覆盖。
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const db = createFakeDb(state, gate);
  setDb(db);

  const { result, unmount } = await renderHook(() => useSyncSummary());

  // 首次读取尚未完成：必须是默认值，调用方不需要处理 undefined。
  expect(result.current).toEqual({
    online: true, pending: 0, problems: 0, lastSyncedAt: null,
  });

  release();
  await waitFor(() => {
    expect(result.current).toEqual({
      online: true, pending: 1, problems: 0, lastSyncedAt: '2026-10-28T09:00:00.000Z',
    });
  });

  // 同步完成后 outbox 变了：事件只表示「可能已变化」，订阅方重新查库。
  state.outbox.push({ scope_id: SCOPE, status: 'failed' });
  state.notices.push({ scope_id: SCOPE, acknowledged_at: null });
  await act(async () => {
    emitSyncChanged();
  });

  await waitFor(() => {
    expect(result.current).toMatchObject({ pending: 1, problems: 2 });
  });

  // 卸载后不再订阅：再发事件不应继续查库。
  await unmount();
  const afterUnmount = db.queries.length;
  await act(async () => {
    emitSyncChanged();
  });
  expect(db.queries.length).toBe(afterUnmount);
});

test('useSyncSummary 在网络状态变化时重新读取并带上新的 online', async () => {
  const state = emptyState();
  state.meta.push({ scope_id: '_global', key: 'current_scope', value: SCOPE });
  const db = createFakeDb(state);
  setDb(db);

  const { result } = await renderHook(() => useSyncSummary());
  await waitFor(() => {
    expect(result.current).toEqual({
      online: true, pending: 0, problems: 0, lastSyncedAt: null,
    });
  });

  mockOnline = false;
  state.outbox.push({ scope_id: SCOPE, status: 'pending' });
  await act(async () => {
    mockNetworkListeners.forEach((cb) => cb(false));
  });

  await waitFor(() => {
    expect(result.current).toMatchObject({ online: false, pending: 1 });
  });
});

test('useBlob 在同步事件后重读 blob', async () => {
  const state = emptyState();
  state.meta.push({ scope_id: '_global', key: 'current_scope', value: SCOPE });
  state.blobs.push({
    scope_id: SCOPE,
    key: 'accounts:2026-10-01:2026-10-31',
    payload: JSON.stringify({ version: 1 }),
    fetched_at: '2026-10-28T09:00:00.000Z',
  });
  const db = createFakeDb(state);
  setDb(db);

  const { result } = await renderHook(() => useBlob<{ version: number }>('accounts:2026-10-01:2026-10-31'));

  await waitFor(() => {
    expect(result.current.data).toEqual({ version: 1 });
  });

  // 同步拉回新数据后，订阅方必须重读，否则界面一直停在旧快照。
  state.blobs[0].payload = JSON.stringify({ version: 2 });
  state.blobs[0].fetched_at = '2026-10-28T10:00:00.000Z';
  await act(async () => {
    emitSyncChanged();
  });

  await waitFor(() => {
    expect(result.current.data).toEqual({ version: 2 });
    expect(result.current.fetchedAt).toBe('2026-10-28T10:00:00.000Z');
  });
  expect(result.current.error).toBe(false);
});
