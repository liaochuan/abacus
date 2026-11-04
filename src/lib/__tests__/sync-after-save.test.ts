import { getSyncState } from '../../db/syncState';
import { runSync } from '../../db/sync';
import { pullBlobs } from '../../db/syncBlobs';
import {
  AFTER_SAVE_DEFER_MS, requestAfterSave, requestBlobSync, requestSync, stopSyncTimer,
} from '../syncScheduler';
import { isOnline } from '../network';

// 保存交易后的同步策略：
// - 第一段只 push（pushOnly），让交易尽快到服务端；
// - pull + blob 由 3 秒去抖的 deferred 整轮补跑，连续保存只跑最后一次；
// - 补跑不把顶栏切成 syncing，也不在 push 未清空队列时安排。

// getMeta 的返回值由用例控制：null = 从未成功同步过。
// 必须声明在 jest.mock 之前：mock 工厂在模块加载时会读取它。
let mockLastSynced: string | null = null;
// outbox 的待推送条数：push 内部吞掉的 network/server 失败会表现为 pending > 0。
let mockPending = 0;

jest.mock('../network', () => ({ __esModule: true, isOnline: jest.fn(() => true) }));
jest.mock('../../db/instance', () => ({
  __esModule: true,
  getDb: () => ({
    get: jest.fn(async (sql: string) => (
      String(sql).includes('outbox') ? { pending: mockPending, failed: 0 } : { count: 0 }
    )),
    all: jest.fn(async () => []),
  }),
}));
jest.mock('../../db/scope', () => ({
  __esModule: true,
  getCurrentScope: jest.fn(async () => 'scope-a'),
}));
jest.mock('../../db/repository', () => ({
  __esModule: true,
  getMeta: jest.fn(async () => mockLastSynced),
  setMeta: jest.fn(),
}));
jest.mock('../../db/sync', () => ({
  __esModule: true,
  AuthExpiredError: class AuthExpiredError extends Error {},
  runSync: jest.fn(async () => ({
    pushed: 0, pulled: 0, deleted: 0, conflicts: 0, failed: 0,
  })),
}));
jest.mock('../syncContext', () => ({
  __esModule: true,
  buildSyncContext: jest.fn(async () => ({})),
}));
jest.mock('../../db/syncBlobs', () => ({
  __esModule: true,
  pullBlobs: jest.fn(async () => 0),
}));

const runSyncMock = runSync as jest.MockedFunction<typeof runSync>;
const isOnlineMock = isOnline as jest.MockedFunction<typeof isOnline>;
const pullBlobsMock = pullBlobs as jest.MockedFunction<typeof pullBlobs>;

const emptyResult = () => ({
  pushed: 0, pulled: 0, deleted: 0, conflicts: 0, failed: 0,
});

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  isOnlineMock.mockReturnValue(true);
  mockLastSynced = null;
  mockPending = 0;
  runSyncMock.mockResolvedValue(emptyResult());
  pullBlobsMock.mockResolvedValue(0);
});

afterEach(() => {
  stopSyncTimer();
  jest.useRealTimers();
});

test('保存后先只 push，延后时间到才补整轮', async () => {
  await requestAfterSave();
  expect(runSyncMock).toHaveBeenCalledTimes(1);
  expect(runSyncMock.mock.calls[0][3]).toMatchObject({ pushOnly: true });

  await jest.advanceTimersByTimeAsync(AFTER_SAVE_DEFER_MS - 1);
  expect(runSyncMock).toHaveBeenCalledTimes(1);

  await jest.advanceTimersByTimeAsync(1);
  await flush();
  expect(runSyncMock).toHaveBeenCalledTimes(2);
  expect(runSyncMock.mock.calls[1][3]?.pushOnly).not.toBe(true);
});

test('连续保存合并为一次补跑，并以最后一次保存为起点', async () => {
  await requestAfterSave();
  await jest.advanceTimersByTimeAsync(1_000);
  await requestAfterSave();

  await jest.advanceTimersByTimeAsync(AFTER_SAVE_DEFER_MS - 1);
  expect(runSyncMock).toHaveBeenCalledTimes(2); // 两次 push
  await jest.advanceTimersByTimeAsync(1);
  await flush();
  expect(runSyncMock).toHaveBeenCalledTimes(3); // 只补一次整轮
});

test('补跑不把顶栏切成 syncing', async () => {
  await requestAfterSave();
  let release: (() => void) | undefined;
  runSyncMock.mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve(emptyResult() as never);
  }) as Promise<never>);

  await jest.advanceTimersByTimeAsync(AFTER_SAVE_DEFER_MS);
  await flush();
  expect(getSyncState().kind).not.toBe('syncing');
  release?.();
  await flush();
});

test('push 抛错时不安排补跑（避免 3 秒后重试失败）', async () => {
  runSyncMock.mockRejectedValueOnce(new Error('boom'));

  await requestAfterSave();
  await jest.advanceTimersByTimeAsync(10_000);

  expect(runSyncMock).toHaveBeenCalledTimes(1);
});

test('同步进行中保存：排队补一次 push，再补一次整轮', async () => {
  let release: (() => void) | undefined;
  runSyncMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }) as Promise<never>);

  const running = requestSync('manual');
  // 让 requestSync 走完 getCurrentScope / buildSyncContext，真正进到 runSync。
  await flush();
  await requestAfterSave(); // 被单飞锁挡住，排队
  expect(runSyncMock).toHaveBeenCalledTimes(1);

  release?.();
  await running;
  await flush();
  // 排队的 push-only 立即补跑
  expect(runSyncMock).toHaveBeenCalledTimes(2);
  expect(runSyncMock.mock.calls[1][3]).toMatchObject({ pushOnly: true });

  await jest.advanceTimersByTimeAsync(AFTER_SAVE_DEFER_MS);
  await flush();
  expect(runSyncMock).toHaveBeenCalledTimes(3);
});

test('stopSyncTimer 之后不再补跑', async () => {
  await requestAfterSave();
  stopSyncTimer();

  await jest.advanceTimersByTimeAsync(10_000);

  expect(runSyncMock).toHaveBeenCalledTimes(1);
});

test('从未成功同步过时，补跑按 startup 做首轮回填', async () => {
  mockLastSynced = null;

  await requestAfterSave();
  await jest.advanceTimersByTimeAsync(AFTER_SAVE_DEFER_MS);
  await flush();

  expect(runSyncMock.mock.calls[1][3]).toMatchObject({ full: true });
});

test('已有成功同步记录时，补跑只做增量拉取', async () => {
  mockLastSynced = new Date().toISOString();

  await requestAfterSave();
  await jest.advanceTimersByTimeAsync(AFTER_SAVE_DEFER_MS);
  await flush();

  expect(runSyncMock.mock.calls[1][3]?.full).not.toBe(true);
});

test('push 未清空 outbox（network/server 被内部吞掉）时不安排补跑', async () => {
  mockPending = 1;

  await requestAfterSave();
  await jest.advanceTimersByTimeAsync(10_000);

  // 还有 pending：交给 60 秒重试，不能 3 秒后绕过退避再打一轮。
  expect(runSyncMock).toHaveBeenCalledTimes(1);
});

test('blob 轮持有锁时保存：结束后补跑 push-only', async () => {
  let release: (() => void) | undefined;
  pullBlobsMock.mockImplementationOnce(() => new Promise<number>((resolve) => {
    release = () => resolve(0);
  }) as never);

  const blob = requestBlobSync();
  await flush();
  expect(pullBlobsMock).toHaveBeenCalledTimes(1);

  await requestAfterSave();
  expect(runSyncMock).not.toHaveBeenCalled();

  release?.();
  await blob;
  await flush();

  expect(runSyncMock).toHaveBeenCalledTimes(1);
  expect(runSyncMock.mock.calls[0][3]).toMatchObject({ pushOnly: true });
});

test('quiet 的 startup 补跑遇到进行中的同步会排队，而不是被丢弃', async () => {
  let release: (() => void) | undefined;
  runSyncMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }) as Promise<never>);

  const running = requestSync('manual');
  await flush();

  await requestSync('startup', { quiet: true });
  expect(runSyncMock).toHaveBeenCalledTimes(1);

  release?.();
  await running;
  await flush();

  expect(runSyncMock).toHaveBeenCalledTimes(2);
  expect(runSyncMock.mock.calls[1][3]).toMatchObject({ full: true });
});
