import { requestSync } from '../syncScheduler';
import { getSyncState } from '../../db/syncState';
import { runSync } from '../../db/sync';

// 失败原因必须落到状态机的 error 上：顶栏图标的 tooltip 只靠这个字段
// 把「网络/登录/服务端」翻成用户能懂的短句，不接触原始 message。
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
  AuthExpiredError: class AuthExpiredError extends Error {
    constructor() {
      super('sync requires re-authentication');
      this.name = 'AuthExpiredError';
    }
  },
  runSync: jest.fn(),
}));
jest.mock('../syncContext', () => ({
  __esModule: true,
  buildSyncContext: jest.fn(async () => ({})),
}));

const runSyncMock = runSync as jest.MockedFunction<typeof runSync>;

const httpError = (status: number) => ({ response: { status } });

beforeEach(() => {
  jest.clearAllMocks();
});

test('服务端 5xx 失败写入 reason=server', async () => {
  runSyncMock.mockRejectedValueOnce(httpError(500));

  await requestSync('manual');

  expect(getSyncState()).toMatchObject({ kind: 'error', reason: 'server' });
});

test('凭证失效写入 reason=auth 而不是 offline', async () => {
  const { AuthExpiredError } = jest.requireMock('../../db/sync') as {
    AuthExpiredError: new () => Error;
  };
  runSyncMock.mockRejectedValueOnce(new AuthExpiredError());

  await requestSync('manual');

  const state = getSyncState();
  expect(state.kind).toBe('error');
  expect(state).toMatchObject({ reason: 'auth' });
});

test('断网失败仍归为 offline，不写 error', async () => {
  runSyncMock.mockRejectedValueOnce(Object.assign(new Error('network down'), { code: 'ERR_NETWORK' }));

  await requestSync('manual');

  expect(getSyncState().kind).toBe('offline');
});
