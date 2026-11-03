import { requestSync, requestSyncIfDue, SYNC_MIN_INTERVAL_MS } from '../syncScheduler';
import { getMeta } from '../../db/repository';
import { getCurrentScope } from '../../db/scope';
import { runSync } from '../../db/sync';
import { buildSyncContext } from '../syncContext';

jest.mock('../network', () => ({ __esModule: true, isOnline: jest.fn(() => true) }));
jest.mock('../../db/instance', () => ({ __esModule: true, getDb: jest.fn(() => ({})) }));
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
const getCurrentScopeMock = getCurrentScope as jest.MockedFunction<typeof getCurrentScope>;
const runSyncMock = runSync as jest.MockedFunction<typeof runSync>;
const buildSyncContextMock = buildSyncContext as jest.MockedFunction<typeof buildSyncContext>;

beforeEach(() => {
  jest.clearAllMocks();
  getMetaMock.mockResolvedValue(null);
  getCurrentScopeMock.mockResolvedValue('scope-a');
  runSyncMock.mockResolvedValue({
    pushed: 0, pulled: 0, deleted: 0, conflicts: 0, failed: 0,
  });
  buildSyncContextMock.mockResolvedValue({} as never);
});

test('距上次成功同步不足 5 分钟时跳过', async () => {
  getMetaMock.mockResolvedValue(new Date(Date.now() - 60_000).toISOString());

  await requestSyncIfDue('foreground');

  expect(runSyncMock).not.toHaveBeenCalled();
});

test('距上次成功同步超过 5 分钟时触发同步', async () => {
  getMetaMock.mockResolvedValue(new Date(Date.now() - SYNC_MIN_INTERVAL_MS - 1_000).toISOString());

  await requestSyncIfDue('foreground');

  expect(runSyncMock).toHaveBeenCalledTimes(1);
});

test('没有上次成功同步记录时触发同步', async () => {
  getMetaMock.mockResolvedValue(null);

  await requestSyncIfDue('foreground');

  expect(runSyncMock).toHaveBeenCalledTimes(1);
});

test('最小间隔是 5 分钟', () => {
  expect(SYNC_MIN_INTERVAL_MS).toBe(300_000);
});

test('同步中途切换账号时，本轮结束后为新 scope 补跑一次', async () => {
  getCurrentScopeMock
    .mockResolvedValueOnce('scope-a')
    .mockResolvedValueOnce('scope-b')
    .mockResolvedValue('scope-b');

  await requestSync('startup');
  // 补跑是 fire-and-forget，等它的微任务链走完。
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  expect(runSyncMock).toHaveBeenCalledTimes(1);
  expect(runSyncMock.mock.calls[0][1]).toBe('scope-b');
});

test('runSync 执行期间切换账号时，同样为新 scope 补跑一次', async () => {
  getCurrentScopeMock.mockResolvedValue('scope-a');
  runSyncMock.mockImplementationOnce(async () => {
    // 模拟网络 push/pull 期间用户切到另一个账号。
    getCurrentScopeMock.mockResolvedValue('scope-b');
    return {
      pushed: 0, pulled: 0, deleted: 0, conflicts: 0, failed: 0,
    };
  });

  await requestSync('startup');
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  expect(runSyncMock).toHaveBeenCalledTimes(2);
  expect(runSyncMock.mock.calls[0][1]).toBe('scope-a');
  expect(runSyncMock.mock.calls[1][1]).toBe('scope-b');
});

test('同步进行中切号：新 scope 的触发会被补跑，而不是被单飞锁丢掉', async () => {
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const running = new Promise<void>((resolve) => { release = resolve; });

  // 1 初次读取 / 2 进入 runSync 前复检 / 3 早退分支读取（切号后）
  // / 4 runSync 后的复检仍返回旧 scope（保证只有早退分支能产生补跑） / 5+ 补跑。
  getCurrentScopeMock
    .mockResolvedValueOnce('scope-a')
    .mockResolvedValueOnce('scope-a')
    .mockResolvedValueOnce('scope-b')
    .mockResolvedValueOnce('scope-a')
    .mockResolvedValue('scope-b');
  runSyncMock.mockImplementationOnce(async () => {
    entered();
    await running;
    return {
      pushed: 0, pulled: 0, deleted: 0, conflicts: 0, failed: 0,
    };
  });

  const first = requestSync('startup');
  await enteredPromise;

  await requestSync('startup');
  release();
  await first;
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  expect(runSyncMock).toHaveBeenCalledTimes(2);
  expect(runSyncMock.mock.calls[0][1]).toBe('scope-a');
  expect(runSyncMock.mock.calls[1][1]).toBe('scope-b');
});

test('runSync 失败且期间切号时，也为新 scope 补跑一次', async () => {
  getCurrentScopeMock.mockResolvedValue('scope-a');
  runSyncMock.mockImplementationOnce(async () => {
    getCurrentScopeMock.mockResolvedValue('scope-b');
    throw Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
  });

  await requestSync('startup');
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  expect(runSyncMock).toHaveBeenCalledTimes(2);
  expect(runSyncMock.mock.calls[1][1]).toBe('scope-b');
});

test('ctx 为空且期间切号时，也为新 scope 补跑一次', async () => {
  getCurrentScopeMock.mockResolvedValue('scope-a');
  buildSyncContextMock.mockImplementationOnce(async () => {
    getCurrentScopeMock.mockResolvedValue('scope-b');
    return null as never;
  });

  await requestSync('startup');
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  expect(runSyncMock).toHaveBeenCalledTimes(1);
  expect(runSyncMock.mock.calls[0][1]).toBe('scope-b');
});

test('同步进行中的 manual 触发会补跑一次，不被单飞锁吞掉', async () => {
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const running = new Promise<void>((resolve) => { release = resolve; });

  getCurrentScopeMock.mockResolvedValue('scope-a');
  runSyncMock.mockImplementationOnce(async () => {
    entered();
    await running;
    return {
      pushed: 0, pulled: 0, deleted: 0, conflicts: 0, failed: 0,
    };
  });

  const first = requestSync('startup');
  await enteredPromise;

  // 同 scope 的 manual（下拉刷新 / 区间变化）：当前轮用的是旧区间，必须补跑。
  await requestSync('manual');

  release();
  await first;
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  expect(runSyncMock).toHaveBeenCalledTimes(2);
  expect(runSyncMock.mock.calls[1][1]).toBe('scope-a');
});
