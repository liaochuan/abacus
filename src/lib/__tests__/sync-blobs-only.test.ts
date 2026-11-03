import { requestBlobSync, requestSync } from '../syncScheduler';
import { getSyncState } from '../../db/syncState';
import { runSync } from '../../db/sync';
import { pullBlobs } from '../../db/syncBlobs';
import { isOnline } from '../network';

// 首页区间 / 币种 / 「全部账户」变化只需要补 blob：
// 不该 push outbox、不该 pull 90 天交易、也不该推进 last_synced_at。
jest.mock('../network', () => ({ __esModule: true, isOnline: jest.fn(() => true) }));
jest.mock('../../db/instance', () => ({ __esModule: true, getDb: jest.fn(() => ({})) }));
jest.mock('../../db/scope', () => ({
  __esModule: true,
  getCurrentScope: jest.fn(async () => 'scope-a'),
}));
jest.mock('../../db/repository', () => ({
  __esModule: true,
  getMeta: jest.fn(async () => null),
  setMeta: jest.fn(),
}));
jest.mock('../../db/sync', () => ({
  __esModule: true,
  AuthExpiredError: class AuthExpiredError extends Error {},
  runSync: jest.fn(async () => ({
    pushed: 0, pulled: 0, deleted: 0, conflicts: 0, failed: 0,
  })),
}));
jest.mock('../../db/syncBlobs', () => ({
  __esModule: true,
  pullBlobs: jest.fn(async () => 3),
}));
jest.mock('../syncContext', () => ({
  __esModule: true,
  buildSyncContext: jest.fn(async () => ({ range: { start: 'a', end: 'b' } })),
}));

const runSyncMock = runSync as jest.MockedFunction<typeof runSync>;
const pullBlobsMock = pullBlobs as jest.MockedFunction<typeof pullBlobs>;
const isOnlineMock = isOnline as jest.MockedFunction<typeof isOnline>;

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  isOnlineMock.mockReturnValue(true);
  pullBlobsMock.mockResolvedValue(3);
});

test('只拉 blob：不 push、不 pull 交易、不推进同步时间', async () => {
  await requestBlobSync();

  expect(pullBlobsMock).toHaveBeenCalledTimes(1);
  expect(runSyncMock).not.toHaveBeenCalled();
});

test('完成后状态回到 idle', async () => {
  await requestBlobSync();

  expect(getSyncState().kind).toBe('idle');
});

test('离线时不发请求', async () => {
  isOnlineMock.mockReturnValue(false);

  await requestBlobSync();

  expect(pullBlobsMock).not.toHaveBeenCalled();
  expect(runSyncMock).not.toHaveBeenCalled();
});

test('正在同步时排队，本轮结束后补跑一次', async () => {
  let release: (() => void) | undefined;
  runSyncMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }) as Promise<never>);

  const running = requestSync('manual');
  // 让 requestSync 走完 getCurrentScope / buildSyncContext，真正进到 runSync。
  await flush();
  expect(runSyncMock).toHaveBeenCalledTimes(1);

  await requestBlobSync();
  expect(pullBlobsMock).not.toHaveBeenCalled();

  release?.();
  await running;
  // 补跑是 fire-and-forget，等微任务队列排空。
  await flush();

  expect(pullBlobsMock).toHaveBeenCalledTimes(1);
});
