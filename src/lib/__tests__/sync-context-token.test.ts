import axios from 'axios';

import { buildSyncContext } from '../syncContext';
import { scopeIdFor } from '../../db/scope';
import { getCredentials } from '../oauth';
import { store } from '../../store';

// 只验证 refreshToken 对全局 header 的副作用：store/凭据读取都被替换，
// 不触碰 Redux 与 SecureStore（真实实现会加载原生模块）。
jest.mock('../../store', () => ({
  __esModule: true,
  store: { dispatch: { firefly: { getFreshAccessToken: jest.fn() } }, getState: jest.fn() },
}));

jest.mock('../oauth', () => ({ __esModule: true, getCredentials: jest.fn() }));

const storeMock = store as unknown as {
  dispatch: { firefly: { getFreshAccessToken: jest.Mock } };
  getState: jest.Mock;
};
const getCredentialsMock = getCredentials as jest.MockedFunction<typeof getCredentials>;

const credential = {
  email: 'user@example.com',
  backendURL: 'https://firefly.example',
  accessToken: 'old-token',
};

const state = {
  configuration: {
    backendURL: 'https://firefly.example',
    displayAllAccounts: false,
    apiVersion: 2,
    selectedBrandStyle: undefined,
  },
  firefly: { rangeDetails: { start: '2026-01-01', end: '2026-03-31' } },
  currencies: { currentCode: 'CNY' },
};

const buildContext = async () => {
  storeMock.getState.mockReturnValue(state);
  const ctx = await buildSyncContext(scopeIdFor(credential.backendURL, credential.email));
  if (!ctx) {
    throw new Error('test setup: sync context should exist');
  }
  return ctx;
};

let originalAuthorization: unknown;

beforeEach(() => {
  jest.clearAllMocks();
  originalAuthorization = axios.defaults.headers.Authorization;
  storeMock.getState.mockReturnValue(state);
});

afterEach(() => {
  if (originalAuthorization === undefined) {
    delete axios.defaults.headers.Authorization;
  } else {
    axios.defaults.headers.Authorization = originalAuthorization as string;
  }
});

test('刷新 token 后恢复全局 Authorization，只把新 token 写进 activeContext', async () => {
  getCredentialsMock
    .mockResolvedValueOnce([credential])
    .mockResolvedValueOnce([{ ...credential, accessToken: 'new-token' }]);
  storeMock.dispatch.firefly.getFreshAccessToken.mockImplementation(async () => {
    // 模拟 firefly effect：它会写全局默认头。
    axios.defaults.headers.Authorization = 'Bearer new-token';
  });
  axios.defaults.headers.Authorization = 'Bearer previous-account';

  const ctx = await buildContext();
  await expect(ctx.refreshToken()).resolves.toBe('new-token');

  expect(axios.defaults.headers.Authorization).toBe('Bearer previous-account');
});

test('刷新失败时同样恢复全局 Authorization（旧账号 token 不残留）', async () => {
  getCredentialsMock.mockResolvedValueOnce([credential]);
  storeMock.dispatch.firefly.getFreshAccessToken.mockImplementation(async () => {
    axios.defaults.headers.Authorization = 'Bearer leaked-from-broken-refresh';
    throw new Error('refresh rejected');
  });
  delete axios.defaults.headers.Authorization;

  const ctx = await buildContext();
  await expect(ctx.refreshToken()).rejects.toThrow('refresh rejected');

  expect(axios.defaults.headers.Authorization).toBeUndefined();
});
