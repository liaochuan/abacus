import React from 'react';
import { Alert } from 'react-native';
import {
  act, fireEvent, render, waitFor,
} from '@testing-library/react-native';

import SettingsScreen from '../SettingsScreen';
import { deleteScope } from '../../../db/repository';
import { getCurrentScope, setCurrentScope } from '../../../db/scope';
import { emitSyncChanged, isSyncRunning } from '../../../db/syncState';
import { requestSync, startSyncTimer, stopSyncTimer } from '../../../lib/syncScheduler';

// 文案断言用 zh-CN 的真实词条：组件只负责选 key，词条完整性由 i18n 测试覆盖。
jest.mock('../../../i18n/locale', () => {
  const zhCN = jest.requireActual('../../../i18n/locale/translations/zh-CN').default as Record<string, string>;
  return {
    __esModule: true,
    default: (key: string) => String(zhCN[key] ?? key),
  };
});

// ALibrary 的 index 会连带加载 AButton（react-redux 未在本项目的 transformIgnorePatterns 内）。
// dispatch 在工厂里创建，测试通过 requireMock 取同一个对象，避免 hoist 顺序问题。
jest.mock('react-redux', () => {
  const dispatch = {
    configuration: {
      setUseBiometricAuth: jest.fn(),
      setCloseTransactionScreen: jest.fn(),
      resetAllStates: jest.fn(() => Promise.resolve()),
    },
  };
  return {
    useSelector: (selector: (state: unknown) => unknown) => selector({
      configuration: {
        closeTransactionScreen: false,
        backendURL: 'https://demo.example.com',
        useBiometricAuth: false,
        selectedBrandStyle: '#000000',
      },
    }),
    useDispatch: () => dispatch,
    __dispatch: dispatch,
  };
});

// 这些 expo 模块只被设置页的其它分组使用，这里只需要可加载的替身。
jest.mock('expo-linking', () => ({ openURL: jest.fn() }));
jest.mock('expo-application', () => ({ nativeApplicationVersion: '1.0.0' }));
jest.mock('expo-local-authentication', () => ({ authenticateAsync: jest.fn() }));
jest.mock('expo-store-review', () => ({
  isAvailableAsync: jest.fn(async () => false),
  requestReview: jest.fn(async () => {}),
}));

jest.mock('../../../db/instance', () => {
  const db = { name: 'fake-db' };
  return { getDb: () => db, __db: db };
});
jest.mock('../../../db/scope', () => ({
  getCurrentScope: jest.fn(async () => 'scope-a'),
  setCurrentScope: jest.fn(async () => {}),
}));
jest.mock('../../../db/repository', () => ({ deleteScope: jest.fn(async () => {}) }));
jest.mock('../../../db/syncState', () => ({
  emitSyncChanged: jest.fn(),
  isSyncRunning: jest.fn(() => false),
}));
jest.mock('../../../lib/syncScheduler', () => ({
  requestSync: jest.fn(() => Promise.resolve()),
  startSyncTimer: jest.fn(),
  stopSyncTimer: jest.fn(),
}));

// 列表本身由 sync-issue-list.test.tsx 覆盖；这里只验证设置页把同一个组件打开。
jest.mock('../../UI/SyncIssueList', () => {
  const ReactNative = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ visible }: { visible: boolean }) => (visible
      ? ReactNative.createElement(Text, null, 'issue-list-open')
      : null),
  };
});

const requestSyncMock = requestSync as jest.MockedFunction<typeof requestSync>;
const deleteScopeMock = deleteScope as jest.MockedFunction<typeof deleteScope>;
const getCurrentScopeMock = getCurrentScope as jest.MockedFunction<typeof getCurrentScope>;
const setCurrentScopeMock = setCurrentScope as jest.MockedFunction<typeof setCurrentScope>;
const emitSyncChangedMock = emitSyncChanged as jest.MockedFunction<typeof emitSyncChanged>;
const isSyncRunningMock = isSyncRunning as jest.MockedFunction<typeof isSyncRunning>;
const stopSyncTimerMock = stopSyncTimer as jest.MockedFunction<typeof stopSyncTimer>;
const startSyncTimerMock = startSyncTimer as jest.MockedFunction<typeof startSyncTimer>;

const { __dispatch: configurationDispatch } = jest.requireMock('react-redux');
const { __db: fakeDb } = jest.requireMock('../../../db/instance');

const navigation = () => ({
  dispatch: jest.fn(),
  navigate: jest.fn(),
});

const renderSettings = async () => {
  const nav = navigation();
  const route = { key: 'settings', name: 'SettingsScreen', params: undefined };
  const view = await render(<SettingsScreen navigation={nav as any} route={route as any} />);
  return { nav, view };
};

beforeEach(() => {
  jest.clearAllMocks();
  getCurrentScopeMock.mockResolvedValue('scope-a');
  isSyncRunningMock.mockReturnValue(false);
});

test('立即同步走调度层的 manual 入口', async () => {
  const { view } = await renderSettings();

  await fireEvent.press(view.getByTestId('settings_sync_now'));

  expect(requestSyncMock).toHaveBeenCalledTimes(1);
  expect(requestSyncMock).toHaveBeenCalledWith('manual');
});

test('查看待处理打开状态条上的同一份失败项列表', async () => {
  const { view } = await renderSettings();

  expect(view.queryByText('issue-list-open')).toBeNull();

  await fireEvent.press(view.getByTestId('settings_sync_issues'));

  expect(view.getByText('issue-list-open')).toBeTruthy();
});

test('重新初始化本地数据需要两次确认，确认后清空 scope 并回到登录页', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const { nav, view } = await renderSettings();

  await fireEvent.press(view.getByTestId('settings_sync_reset'));

  // 第一次确认只说明后果，还没碰库。
  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(deleteScopeMock).not.toHaveBeenCalled();

  const firstButtons = alertSpy.mock.calls[0][2];
  const firstConfirm = firstButtons?.[1];
  expect(firstConfirm?.style).toBe('destructive');
  await act(async () => {
    firstConfirm?.onPress?.();
  });

  // 第二次确认才是真正执行。
  expect(alertSpy).toHaveBeenCalledTimes(2);
  expect(deleteScopeMock).not.toHaveBeenCalled();

  const secondButtons = alertSpy.mock.calls[1][2];
  await act(async () => {
    secondButtons?.[1]?.onPress?.();
  });

  await waitFor(() => {
    expect(deleteScopeMock).toHaveBeenCalledWith(fakeDb, 'scope-a');
    expect(setCurrentScopeMock).toHaveBeenCalledWith(fakeDb, '');
    expect(emitSyncChangedMock).toHaveBeenCalled();
    expect(configurationDispatch.configuration.resetAllStates).toHaveBeenCalled();
  });

  // 成功路径在跳转前也要把周期同步恢复回来。
  expect(stopSyncTimerMock).toHaveBeenCalledTimes(1);
  expect(startSyncTimerMock).toHaveBeenCalledTimes(1);

  // 重置后回到登录页（与「退出登录」同一个落点）。
  expect(nav.dispatch).toHaveBeenCalledTimes(1);
  expect(nav.dispatch.mock.calls[0][0].payload.routes[0]).toMatchObject({
    name: 'credentials',
    params: { noRedirect: true },
  });
});

// 依次点开第一次确认与第二次确认：第二次的按钮才真正执行重置。
const confirmResetTwice = async (
  alertSpy: jest.SpyInstance,
  view: Awaited<ReturnType<typeof renderSettings>>['view'],
) => {
  await fireEvent.press(view.getByTestId('settings_sync_reset'));

  const firstButtons = alertSpy.mock.calls[0][2];
  await act(async () => {
    firstButtons?.[1]?.onPress?.();
  });

  const secondButtons = alertSpy.mock.calls[1][2];
  await act(async () => {
    secondButtons?.[1]?.onPress?.();
  });
};

test('第二次确认说明只删除本地数据，不提凭证或服务器', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const { view } = await renderSettings();

  await confirmResetTwice(alertSpy, view);

  expect(alertSpy.mock.calls[1][0]).toBe('删除本地数据？');
  expect(alertSpy.mock.calls[1][1]).toBe(
    '仅删除本机当前账号的交易缓存与待同步队列，不会删除服务器数据或登录凭证。',
  );
});

test('同步进行中时拒绝重置：不碰定时器、提示稍后再试、不碰库不跳转', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  isSyncRunningMock.mockReturnValue(true);
  const { nav, view } = await renderSettings();

  await confirmResetTwice(alertSpy, view);

  await waitFor(() => {
    expect(alertSpy).toHaveBeenCalledTimes(3);
  });
  // 最便宜的失败路径不得留下副作用：既不停表，也不重启，定时器原样继续。
  expect(stopSyncTimerMock).not.toHaveBeenCalled();
  expect(startSyncTimerMock).not.toHaveBeenCalled();
  expect(alertSpy.mock.calls[2][0]).toBe('正在同步，请稍后重试');
  expect(deleteScopeMock).not.toHaveBeenCalled();
  expect(setCurrentScopeMock).not.toHaveBeenCalled();
  expect(nav.dispatch).not.toHaveBeenCalled();
});

test('删除失败时提示通用错误并留在当前页，不收起 scope', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  deleteScopeMock.mockRejectedValueOnce(new Error('disk full'));
  const { nav, view } = await renderSettings();

  await confirmResetTwice(alertSpy, view);

  await waitFor(() => {
    expect(alertSpy).toHaveBeenCalledTimes(3);
  });
  expect(alertSpy.mock.calls[2][0]).toBe('出错了');
  expect(stopSyncTimerMock).toHaveBeenCalled();
  // 失败后必须恢复周期同步，否则一次失败会永久关掉定时器。
  expect(startSyncTimerMock).toHaveBeenCalledTimes(1);
  expect(setCurrentScopeMock).not.toHaveBeenCalled();
  expect(configurationDispatch.configuration.resetAllStates).not.toHaveBeenCalled();
  expect(nav.dispatch).not.toHaveBeenCalled();
});

test('第一次确认选取消时不清库也不跳转', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const { nav, view } = await renderSettings();

  await fireEvent.press(view.getByTestId('settings_sync_reset'));

  const cancel = alertSpy.mock.calls[0][2]?.[0];
  await act(async () => {
    cancel?.onPress?.();
  });

  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(deleteScopeMock).not.toHaveBeenCalled();
  expect(nav.dispatch).not.toHaveBeenCalled();
});
