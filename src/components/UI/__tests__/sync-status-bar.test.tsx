import React from 'react';
import { StyleSheet } from 'react-native';
import {
  act, fireEvent, render, screen,
} from '@testing-library/react-native';

import SyncStatusBar, { statusBarText } from '../SyncStatusBar';
import type { SyncSummary } from '../../../db/useSyncSummary';
import { useSyncSummary } from '../../../db/useSyncSummary';
import { getSyncState, subscribeSyncChanged } from '../../../db/syncState';
import { requestSync } from '../../../lib/syncScheduler';

// 文案断言用 zh-CN 的真实词条：组件只负责按优先级选择 key 与传参，
// 词条本身由 i18n/__tests__/translations.test.ts 覆盖 15 种语言的完整性。
jest.mock('../../../i18n/locale', () => {
  const zhCN = jest.requireActual('../../../i18n/locale/translations/zh-CN').default as Record<string, string>;
  return {
    __esModule: true,
    default: (key: string, options?: { count?: number }) => String(zhCN[key] ?? key)
      .replace('%{count}', String(options?.count ?? '')),
  };
});

// ALibrary 的 index 会连带加载 AButton（react-redux 未在本项目的 transformIgnorePatterns 内）。
// 与 autocomplete-offline.test.tsx 一致，用最小 selector 替身绕开整棵 store。
jest.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) => selector({
    configuration: { selectedBrandStyle: '#000000' },
  }),
}));

jest.mock('../../../db/useSyncSummary', () => ({
  __esModule: true,
  useSyncSummary: jest.fn(),
}));

jest.mock('../../../db/syncState', () => ({
  __esModule: true,
  getSyncState: jest.fn(),
  isSyncFailing: (state: { kind: string }) => state.kind === 'error',
  subscribeSyncChanged: jest.fn(),
}));

jest.mock('../../../lib/syncScheduler', () => ({
  __esModule: true,
  requestSync: jest.fn(() => Promise.resolve()),
}));

// 列表本身由 sync-issue-list.test.tsx 覆盖；这里只验证状态条在正确时机把它打开。
jest.mock('../SyncIssueList', () => {
  const React = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ visible }: { visible: boolean }) => (visible
      ? React.createElement(Text, null, 'issue-list-open')
      : null),
  };
});

const useSyncSummaryMock = useSyncSummary as jest.MockedFunction<typeof useSyncSummary>;
const getSyncStateMock = getSyncState as jest.MockedFunction<typeof getSyncState>;
const subscribeSyncChangedMock = subscribeSyncChanged as jest.MockedFunction<typeof subscribeSyncChanged>;
const requestSyncMock = requestSync as jest.MockedFunction<typeof requestSync>;

const base: SyncSummary = {
  online: true,
  pending: 0,
  problems: 0,
  lastSyncedAt: '2026-10-27T04:30:00Z',
};

const idleState = {
  kind: 'idle' as const,
  lastSyncedAt: '2026-10-27T04:30:00Z',
  pending: 0,
  problems: 0,
};

const button = () => screen.getByTestId('sync_status_bar_button');

const rowOpacity = () => StyleSheet.flatten(screen.root?.props.style).opacity;

beforeEach(() => {
  jest.clearAllMocks();
  useSyncSummaryMock.mockReturnValue(base);
  getSyncStateMock.mockReturnValue(idleState);
  subscribeSyncChangedMock.mockReturnValue(jest.fn());
});

test('状态条文案', () => {
  expect(statusBarText(base, { syncing: false })).toContain('已同步');
  expect(statusBarText({ ...base, online: false }, { syncing: false })).toContain('离线');
  expect(statusBarText({ ...base, pending: 3 }, { syncing: false })).toContain('3 条待上传');
  expect(statusBarText({ ...base, problems: 2 }, { syncing: false })).toContain('2 条需处理');
  expect(statusBarText(base, { syncing: true })).toContain('同步中');
});

test('优先级：同步中 > 离线 > 同步出错 > 需处理 > 待上传 > 已同步', () => {
  const dirty: SyncSummary = {
    online: false,
    pending: 3,
    problems: 2,
    lastSyncedAt: '2026-10-27T04:30:00Z',
  };

  expect(statusBarText(dirty, { syncing: true })).toContain('同步中');
  expect(statusBarText(dirty, { syncing: false })).toContain('离线');
  expect(statusBarText({ ...dirty, online: true }, { syncing: false })).toContain('2 条需处理');
  expect(statusBarText({ ...dirty, online: true, problems: 0 }, { syncing: false })).toContain('3 条待上传');
});

test('已同步时带上本地 HH:mm', () => {
  expect(statusBarText(base, { syncing: false })).toMatch(/\d{2}:\d{2}/);
});

test('上一轮失败时不显示已同步', () => {
  expect(statusBarText(base, { syncing: false, failing: true })).toContain('同步出错');
  // 离线优先于出错：用户先要知道「现在没网」。
  expect(statusBarText({ ...base, online: false }, { syncing: false, failing: true }))
    .toContain('离线');
  expect(statusBarText(base, { syncing: true, failing: true })).toContain('同步中');
});

test('同步失败时渲染错误文案并恢复正常不透明度', async () => {
  getSyncStateMock.mockReturnValue({
    kind: 'error',
    message: 'sync failed',
    lastSyncedAt: '2026-10-27T04:30:00Z',
    pending: 0,
    problems: 0,
  });
  await render(<SyncStatusBar />);

  expect(screen.getByText('同步出错')).toBeTruthy();
  expect(rowOpacity()).toBe(1);
});

test('从未成功同步时不拼时间，只显示已同步', () => {
  expect(statusBarText({ ...base, lastSyncedAt: null }, { syncing: false })).toBe('已同步');
});

test('渲染文案并点击按钮触发手动同步', async () => {
  useSyncSummaryMock.mockReturnValue({ ...base, pending: 3 });
  await render(<SyncStatusBar />);

  expect(screen.getByText('3 条待上传')).toBeTruthy();

  await fireEvent.press(button());

  expect(requestSyncMock).toHaveBeenCalledTimes(1);
  expect(requestSyncMock).toHaveBeenCalledWith('manual');
});

test('同步中禁用按钮并显示同步中', async () => {
  getSyncStateMock.mockReturnValue({ kind: 'syncing', phase: 'push' });
  await render(<SyncStatusBar />);

  expect(screen.getByText('同步中…')).toBeTruthy();

  await fireEvent.press(button());

  expect(requestSyncMock).not.toHaveBeenCalled();
});

test('同步状态变化时重新渲染', async () => {
  let listener: () => void = () => {};
  subscribeSyncChangedMock.mockImplementation((fn) => {
    listener = fn;
    return jest.fn();
  });
  await render(<SyncStatusBar />);

  expect(screen.getByText(/已同步/)).toBeTruthy();

  getSyncStateMock.mockReturnValue({ kind: 'syncing', phase: 'pull' });
  await act(async () => {
    listener();
  });

  expect(screen.getByText('同步中…')).toBeTruthy();
});

test('有需处理项时点击文案打开失败项列表', async () => {
  useSyncSummaryMock.mockReturnValue({ ...base, problems: 2 });
  await render(<SyncStatusBar />);

  expect(screen.queryByText('issue-list-open')).toBeNull();

  await fireEvent.press(screen.getByText('2 条需处理'));

  expect(screen.getByText('issue-list-open')).toBeTruthy();
});

test('没有需处理项时点击文案不打开列表', async () => {
  useSyncSummaryMock.mockReturnValue({ ...base, pending: 3 });
  await render(<SyncStatusBar />);

  expect(screen.getByText('3 条待上传')).toBeTruthy();

  await fireEvent.press(screen.getByText('3 条待上传'));

  expect(screen.queryByText('issue-list-open')).toBeNull();
});

test('全部同步后降低不透明度，有积压时恢复正常', async () => {
  const { rerender } = await render(<SyncStatusBar />);
  expect(rowOpacity()).toBe(0.6);

  useSyncSummaryMock.mockReturnValue({ ...base, pending: 2 });
  await rerender(<SyncStatusBar />);
  expect(rowOpacity()).toBe(1);
});
