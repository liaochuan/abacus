import axios from 'axios';

import { buildSyncContext } from '../syncContext';
import { getCurrentScope, scopeIdFor } from '../../db/scope';
import { readCachedCurrentCode } from '../../db/cachedCurrencies';
import { getCredentials } from '../oauth';
import { store } from '../../store';

// 首次安装 / 登录后进入 dashboard 时，Redux 的 currencies.currentCode 可能还是空串
// （HomeScreen 的 getCurrencies、Redux persist、cachedCurrentCode 都会写它，但都未必及时）。
// 同步上下文必须自己把币种补齐，否则 blobs 会写到 `accounts:start:end::asset` 这种
// 空币种键上，首页永远读不到。
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    defaults: { headers: {} },
    create: jest.fn(() => ({
      get: jest.fn(),
      interceptors: { request: { use: jest.fn() } },
    })),
  },
}));

jest.mock('../../store', () => ({
  __esModule: true,
  store: {
    dispatch: {
      firefly: { getFreshAccessToken: jest.fn() },
      currencies: { getCurrencies: jest.fn(), setCurrentCode: jest.fn() },
    },
    getState: jest.fn(),
  },
}));

jest.mock('../oauth', () => ({ __esModule: true, getCredentials: jest.fn() }));
jest.mock('../../db/cachedCurrencies', () => ({
  __esModule: true,
  readCachedCurrentCode: jest.fn(),
}));
jest.mock('../../db/instance', () => ({
  __esModule: true,
  getDb: jest.fn(() => ({ name: 'fake-db' })),
}));
jest.mock('../../db/scope', () => ({
  __esModule: true,
  scopeIdFor: jest.requireActual('../../db/scope').scopeIdFor,
  getCurrentScope: jest.fn(),
}));

const storeMock = store as unknown as {
  dispatch: {
    firefly: { getFreshAccessToken: jest.Mock };
    currencies: { getCurrencies: jest.Mock; setCurrentCode: jest.Mock };
  };
  getState: jest.Mock;
};
const getCurrentScopeMock = getCurrentScope as jest.MockedFunction<typeof getCurrentScope>;
const getCredentialsMock = getCredentials as jest.MockedFunction<typeof getCredentials>;
const readCachedCurrentCodeMock = readCachedCurrentCode as jest.MockedFunction<
  typeof readCachedCurrentCode
>;
// syncContext 模块加载时创建的唯一 http 实例（30s 超时）。
const httpMock = (axios.create as jest.Mock).mock.results[0].value as { get: jest.Mock };
// resetAllMocks 会清空 create 的调用记录，先留存创建参数用于断言超时。
const httpCreateArgs = (axios.create as jest.Mock).mock.calls[0];

const credential = {
  email: 'user@example.com',
  backendURL: 'https://firefly.example',
  accessToken: 'token',
};

const scopeId = scopeIdFor(credential.backendURL, credential.email);

const makeState = (currentCode: string) => ({
  configuration: {
    backendURL: 'https://firefly.example',
    displayAllAccounts: false,
    apiVersion: '6.3.0',
    selectedBrandStyle: undefined,
  },
  firefly: { rangeDetails: { start: '2026-01-01', end: '2026-03-31' } },
  currencies: { currentCode },
});

beforeEach(() => {
  jest.resetAllMocks();
  getCredentialsMock.mockResolvedValue([credential] as never);
  readCachedCurrentCodeMock.mockResolvedValue(null);
  getCurrentScopeMock.mockResolvedValue(scopeId);
});

test('币种已存在时不读缓存也不发请求', async () => {
  storeMock.getState.mockReturnValue(makeState('CNY'));

  const ctx = await buildSyncContext(scopeId);

  expect(readCachedCurrentCodeMock).not.toHaveBeenCalled();
  expect(httpMock.get).not.toHaveBeenCalled();
  expect(ctx?.currencyCode).toBe('CNY');
  expect(storeMock.dispatch.currencies.setCurrentCode).not.toHaveBeenCalled();
});

test('用于探测币种的 http 必须带超时，避免挂起时占死单飞锁', () => {
  expect(httpCreateArgs).toEqual([{ timeout: 30_000 }]);
});

test('探测失败时回落当前 scope 已缓存的币种', async () => {
  storeMock.getState.mockReturnValue(makeState(''));
  readCachedCurrentCodeMock.mockResolvedValue('EUR');
  httpMock.get.mockRejectedValue(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));

  const ctx = await buildSyncContext(scopeId);

  expect(httpMock.get).toHaveBeenCalledWith('https://firefly.example/api/v1/currencies');
  expect(ctx?.currencyCode).toBe('EUR');
  expect(storeMock.dispatch.currencies.setCurrentCode).toHaveBeenCalledWith('EUR');
});

test('缓存也没有时用当前账号 token 拉默认币种', async () => {
  storeMock.getState.mockReturnValue(makeState(''));
  httpMock.get.mockResolvedValue({
    data: {
      data: [
        { attributes: { default: false, enabled: true, code: 'EUR' } },
        { attributes: { default: true, enabled: true, code: 'USD' } },
      ],
    },
  });

  const ctx = await buildSyncContext(scopeId);

  expect(httpMock.get).toHaveBeenCalledWith('https://firefly.example/api/v1/currencies');
  expect(ctx?.currencyCode).toBe('USD');
  // 不重新拉全局币种列表（getCurrencies）；只把当前币种补回 Redux。
  expect(storeMock.dispatch.currencies.getCurrencies).not.toHaveBeenCalled();
  expect(storeMock.dispatch.currencies.setCurrentCode).toHaveBeenCalledWith('USD');
});

test('币种探测失败时向上抛错，不能静默返回 null', async () => {
  storeMock.getState.mockReturnValue(makeState(''));
  httpMock.get.mockRejectedValue(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));

  await expect(buildSyncContext(scopeId)).rejects.toThrow('Network Error');
});

test('服务端没有默认币种时向上抛错，不用空币种组装上下文', async () => {
  storeMock.getState.mockReturnValue(makeState(''));
  httpMock.get.mockResolvedValue({ data: { data: [] } });

  await expect(buildSyncContext(scopeId)).rejects.toThrow('sync currency unavailable');
});

test('探测遇到 401 时刷新 token，并用新 token 组装上下文', async () => {
  storeMock.getState.mockReturnValue(makeState(''));
  getCredentialsMock
    .mockResolvedValueOnce([credential] as never)
    .mockResolvedValueOnce([{ ...credential, accessToken: 'fresh-token' }] as never);
  storeMock.dispatch.firefly.getFreshAccessToken.mockResolvedValue(undefined);
  httpMock.get
    .mockRejectedValueOnce({ response: { status: 401 } })
    .mockResolvedValueOnce({
      data: { data: [{ attributes: { default: true, enabled: true, code: 'USD' } }] },
    });

  const ctx = await buildSyncContext(scopeId);

  expect(httpMock.get).toHaveBeenCalledTimes(2);
  expect(ctx?.accessToken).toBe('fresh-token');
  expect(ctx?.currencyCode).toBe('USD');
});

test('401 刷新后重试仍失败时仍回落缓存币种', async () => {
  storeMock.getState.mockReturnValue(makeState(''));
  readCachedCurrentCodeMock.mockResolvedValue('EUR');
  getCredentialsMock
    .mockResolvedValueOnce([credential] as never)
    .mockResolvedValueOnce([{ ...credential, accessToken: 'fresh-token' }] as never);
  storeMock.dispatch.firefly.getFreshAccessToken.mockResolvedValue(undefined);
  httpMock.get
    .mockRejectedValueOnce({ response: { status: 401 } })
    .mockRejectedValueOnce(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));

  const ctx = await buildSyncContext(scopeId);

  expect(ctx?.currencyCode).toBe('EUR');
  expect(ctx?.accessToken).toBe('fresh-token');
});

test('探测期间切号时不回写全局币种', async () => {
  storeMock.getState.mockReturnValue(makeState(''));
  getCurrentScopeMock.mockResolvedValue('scope-other');
  httpMock.get.mockResolvedValue({
    data: { data: [{ attributes: { default: true, enabled: true, code: 'USD' } }] },
  });

  const ctx = await buildSyncContext(scopeId);

  expect(ctx?.currencyCode).toBe('USD');
  expect(storeMock.dispatch.currencies.setCurrentCode).not.toHaveBeenCalled();
});
