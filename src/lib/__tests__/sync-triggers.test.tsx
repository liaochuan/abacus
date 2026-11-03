import React from 'react';
import { AppState } from 'react-native';
import { act, render } from '@testing-library/react-native';

import SyncTriggers from '../syncTriggers';
import {
  requestSync,
  requestSyncIfDue,
  startSyncTimer,
  stopSyncTimer,
} from '../syncScheduler';
import { subscribeNetwork } from '../network';

jest.mock('../syncScheduler', () => ({
  __esModule: true,
  requestSync: jest.fn(() => Promise.resolve()),
  requestSyncIfDue: jest.fn(() => Promise.resolve()),
  startSyncTimer: jest.fn(),
  stopSyncTimer: jest.fn(),
}));

jest.mock('../network', () => ({
  __esModule: true,
  subscribeNetwork: jest.fn(),
}));

const requestSyncMock = requestSync as jest.MockedFunction<typeof requestSync>;
const requestSyncIfDueMock = requestSyncIfDue as jest.MockedFunction<typeof requestSyncIfDue>;
const startSyncTimerMock = startSyncTimer as jest.MockedFunction<typeof startSyncTimer>;
const stopSyncTimerMock = stopSyncTimer as jest.MockedFunction<typeof stopSyncTimer>;
const subscribeNetworkMock = subscribeNetwork as jest.MockedFunction<typeof subscribeNetwork>;

let appStateHandler: ((status: string) => void) | null = null;
let networkHandler: ((online: boolean) => void) | null = null;
let originalAppState: unknown;

beforeEach(() => {
  jest.clearAllMocks();
  appStateHandler = null;
  networkHandler = null;
  requestSyncMock.mockResolvedValue(undefined);
  requestSyncIfDueMock.mockResolvedValue(undefined);

  originalAppState = AppState.currentState;
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    get: () => 'active',
  });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, handler) => {
    appStateHandler = handler as unknown as (status: string) => void;
    return { remove: jest.fn() } as never;
  });
  subscribeNetworkMock.mockImplementation((handler) => {
    networkHandler = handler;
    return jest.fn();
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: originalAppState,
  });
});

test('冷启动无条件同步一次，并启动定时器', async () => {
  const view = await render(<SyncTriggers />);

  expect(requestSyncMock).toHaveBeenCalledTimes(1);
  expect(requestSyncMock).toHaveBeenCalledWith('startup');
  expect(startSyncTimerMock).toHaveBeenCalledTimes(1);

  await view.unmount();
  expect(stopSyncTimerMock).toHaveBeenCalledTimes(1);
});

test('后台转回前台按 5 分钟间隔判断，前台重复事件不触发', async () => {
  await render(<SyncTriggers />);

  await act(async () => {
    appStateHandler?.('background');
  });
  await act(async () => {
    appStateHandler?.('active');
  });

  expect(requestSyncIfDueMock).toHaveBeenCalledTimes(1);
  expect(requestSyncIfDueMock).toHaveBeenCalledWith('foreground');
  // 只应有冷启动那一次主动同步，前台恢复走 due 判断。
  expect(requestSyncMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    appStateHandler?.('active');
  });
  expect(requestSyncIfDueMock).toHaveBeenCalledTimes(1);
});

test('网络恢复仍立即同步，订阅时的首个基线事件忽略', async () => {
  await render(<SyncTriggers />);

  await act(async () => {
    networkHandler?.(true);
  });
  expect(requestSyncMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    networkHandler?.(false);
  });
  await act(async () => {
    networkHandler?.(true);
  });

  expect(requestSyncMock).toHaveBeenCalledWith('online');
  expect(requestSyncMock).toHaveBeenCalledTimes(2);
});
