import { requestSync, startSyncTimer, stopSyncTimer } from '../syncScheduler';
import { getMeta } from '../../db/repository';
import { runSync } from '../../db/sync';
import { buildSyncContext } from '../syncContext';

// 定时器的输入只有 outbox 的 pending 数；用可变变量控制 readSnapshot 的返回值。
let mockPending = 0;

jest.mock('../network', () => ({ __esModule: true, isOnline: jest.fn(() => true) }));
jest.mock('../../db/instance', () => ({
  __esModule: true,
  getDb: () => ({
    get: jest.fn(async (sql: string) => (
      String(sql).includes('outbox')
        ? { pending: mockPending, failed: 0 }
        : { count: 0 }
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
  getMeta: jest.fn(),
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

const getMetaMock = getMeta as jest.MockedFunction<typeof getMeta>;
const runSyncMock = runSync as jest.MockedFunction<typeof runSync>;
const buildSyncContextMock = buildSyncContext as jest.MockedFunction<typeof buildSyncContext>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockPending = 0;
  getMetaMock.mockResolvedValue(new Date().toISOString());
  runSyncMock.mockResolvedValue({
    pushed: 0, pulled: 0, deleted: 0, conflicts: 0, failed: 0,
  });
  buildSyncContextMock.mockResolvedValue({} as never);
});

afterEach(() => {
  stopSyncTimer();
  jest.useRealTimers();
});

test('空闲时停表，不再周期性轮询', async () => {
  mockPending = 0;
  startSyncTimer();
  await jest.advanceTimersByTimeAsync(0);

  await jest.advanceTimersByTimeAsync(30 * 60_000);
  expect(runSyncMock).not.toHaveBeenCalled();
});

test('outbox 有积压时 60 秒后重试', async () => {
  mockPending = 1;
  startSyncTimer();
  await jest.advanceTimersByTimeAsync(0);
  expect(runSyncMock).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(60_000);
  await jest.advanceTimersByTimeAsync(0);

  expect(runSyncMock).toHaveBeenCalledTimes(1);
});

test('空闲停表后有新的积压，同步结束会重新拉起 60 秒重试', async () => {
  mockPending = 0;
  startSyncTimer();
  await jest.advanceTimersByTimeAsync(0);

  // 定时器已停表；此时一次在线保存留下 pending（推送失败），同步结束必须重启重试。
  mockPending = 1;
  await requestSync('after-save');
  expect(runSyncMock).toHaveBeenCalledTimes(1);
  runSyncMock.mockClear();

  await jest.advanceTimersByTimeAsync(60_000);
  await jest.advanceTimersByTimeAsync(0);
  expect(runSyncMock).toHaveBeenCalledTimes(1);
});

test('stopSyncTimer 之后，正在结束的同步不会把定时器复活', async () => {
  mockPending = 1;
  startSyncTimer();
  await jest.advanceTimersByTimeAsync(0);
  stopSyncTimer();

  await requestSync('manual');
  expect(runSyncMock).toHaveBeenCalledTimes(1);
  runSyncMock.mockClear();

  await jest.advanceTimersByTimeAsync(10 * 60_000);
  expect(runSyncMock).not.toHaveBeenCalled();
});
