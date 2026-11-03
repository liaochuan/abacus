import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import {
  act, fireEvent, render, screen,
} from '@testing-library/react-native';

import SyncStatusIcon, {
  syncLastSyncedLabel,
  syncReasonLabel,
  syncStatusKind,
} from '../SyncStatusIcon';
import type { SyncSummary } from '../../../db/useSyncSummary';
import type { SyncErrorKind } from '../../../db/syncErrors';
import { useSyncSummary } from '../../../db/useSyncSummary';
import { getSyncState, subscribeSyncChanged } from '../../../db/syncState';
import { requestSync } from '../../../lib/syncScheduler';

// 组件用 useNavigation 订阅失焦事件：测试里把 blur 回调收集起来手动触发。
const mockBlurHandlers: Array<() => void> = [];

jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useNavigation: () => ({
    addListener: (event: string, handler: () => void) => {
      if (event === 'blur') {
        mockBlurHandlers.push(handler);
      }
      return () => {};
    },
  }),
}));

jest.mock('../../../i18n/locale', () => {
  const zhCN = jest.requireActual('../../../i18n/locale/translations/zh-CN').default as Record<string, string>;
  return {
    __esModule: true,
    default: (key: string, options?: { count?: number }) => String(zhCN[key] ?? key)
      .replace('%{count}', String(options?.count ?? '')),
  };
});

jest.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) => selector({
    configuration: { selectedBrandStyle: '#000000' },
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  __esModule: true,
  useSafeAreaInsets: () => ({
    top: 47, right: 0, bottom: 34, left: 0,
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

jest.mock('../SyncIssueList', () => {
  const react = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ visible }: { visible: boolean }) => (visible
      ? react.createElement(Text, null, 'issue-list-open')
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

beforeEach(() => {
  jest.clearAllMocks();
  mockBlurHandlers.length = 0;
  // 默认按 Android 跑：iOS 的 Modal 顺序有单独用例覆盖。
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  useSyncSummaryMock.mockReturnValue(base);
  getSyncStateMock.mockReturnValue(idleState);
  subscribeSyncChangedMock.mockReturnValue(jest.fn());
});

test('状态映射：同步中 > 离线 > 失败 > 已同步', () => {
  expect(syncStatusKind(base, { syncing: true, failing: false })).toBe('syncing');
  expect(syncStatusKind({ ...base, online: false }, { syncing: false, failing: true })).toBe('offline');
  expect(syncStatusKind(base, { syncing: false, failing: false, offline: true })).toBe('offline');
  expect(syncStatusKind({ ...base, problems: 2 }, { syncing: false, failing: false })).toBe('failed');
  expect(syncStatusKind(base, { syncing: false, failing: true })).toBe('failed');
  expect(syncStatusKind(base, { syncing: false, failing: false })).toBe('synced');
});

test('上次同步文案', () => {
  expect(syncLastSyncedLabel(null)).toBe('尚未成功同步');
  expect(syncLastSyncedLabel('2026-10-27T04:30:00Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('非法时间串退回「尚未成功同步」，不显示 Invalid date', () => {
  expect(syncLastSyncedLabel('not-a-date')).toBe('尚未成功同步');
  expect(syncLastSyncedLabel('')).toBe('尚未成功同步');
});

test('每种失败原因都有对应文案', () => {
  const kinds: SyncErrorKind[] = ['network', 'auth', 'gone', 'invalid', 'server', 'other'];

  kinds.forEach((kind) => {
    expect(syncReasonLabel(kind)).not.toMatch(/^sync_error_reason_/);
  });
});

test('失败原因按分类翻译，未知为 null', () => {
  expect(syncReasonLabel('auth')).toBe('登录已过期');
  expect(syncReasonLabel('server')).toBe('服务端错误');
  expect(syncReasonLabel(undefined)).toBeNull();
});

test('点击图标打开 tooltip 并展示详情', async () => {
  useSyncSummaryMock.mockReturnValue({ ...base, pending: 3, problems: 2 });
  getSyncStateMock.mockReturnValue({ ...idleState, problems: 2 });

  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));

  expect(screen.getByTestId('sync_tooltip')).toBeTruthy();
  expect(screen.getByText('同步出错')).toBeTruthy();
  expect(screen.getByText('3 条待上传')).toBeTruthy();
  expect(screen.getByText('2 条需处理')).toBeTruthy();
});

test('失败态展示可翻译的失败原因', async () => {
  getSyncStateMock.mockReturnValue({
    kind: 'error',
    reason: 'auth',
    message: 'sync requires re-authentication',
    lastSyncedAt: null,
    pending: 0,
    problems: 0,
  });

  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));

  expect(screen.getByText('失败原因')).toBeTruthy();
  expect(screen.getByText('登录已过期')).toBeTruthy();
  expect(screen.queryByText('sync requires re-authentication')).toBeNull();
});

test('立即同步调用 requestSync 并关闭 tooltip', async () => {
  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));
  await fireEvent.press(screen.getByTestId('sync_tooltip_sync_now'));

  expect(requestSyncMock).toHaveBeenCalledWith('manual');
  expect(screen.queryByTestId('sync_tooltip')).toBeNull();
});

test('同步中禁用立即同步', async () => {
  getSyncStateMock.mockReturnValue({ kind: 'syncing', phase: 'push' });

  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));

  const button = screen.getByTestId('sync_tooltip_sync_now');
  expect(button.props.accessibilityState?.disabled).toBe(true);
  expect(screen.getByText('同步中…')).toBeTruthy();
});

test('需处理入口打开失败项列表', async () => {
  useSyncSummaryMock.mockReturnValue({ ...base, problems: 1 });

  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));
  await fireEvent.press(screen.getByTestId('sync_tooltip_issues'));

  expect(screen.getByText('issue-list-open')).toBeTruthy();
});

test('点遮罩关闭 tooltip', async () => {
  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));
  await fireEvent.press(screen.getByTestId('sync_tooltip_backdrop'));

  expect(screen.queryByTestId('sync_tooltip')).toBeNull();
});

test('气泡展示上次同步时间', async () => {
  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));

  expect(screen.getByText('上次同步')).toBeTruthy();
  expect(screen.getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)).toBeTruthy();
});

test('尚未成功同步时显示占位文案', async () => {
  useSyncSummaryMock.mockReturnValue({ ...base, lastSyncedAt: null });

  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));

  expect(screen.getByText('尚未成功同步')).toBeTruthy();
});

test('离线时显示离线标题', async () => {
  useSyncSummaryMock.mockReturnValue({ ...base, online: false });

  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));

  expect(screen.getByText('离线')).toBeTruthy();
});

test('有待上传时气泡标题不再显示已同步', async () => {
  useSyncSummaryMock.mockReturnValue({ ...base, pending: 3 });

  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));

  expect(screen.queryByText('已同步')).toBeNull();
  expect(screen.getAllByText('3 条待上传').length).toBeGreaterThan(0);
});

test('没有需处理项时不显示失败项入口', async () => {
  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));

  expect(screen.queryByTestId('sync_tooltip_issues')).toBeNull();
});

test('图标容器与顶栏其他按钮同高，保证垂直居中', async () => {
  await render(<SyncStatusIcon />);

  const style = StyleSheet.flatten(screen.getByTestId('sync_status_icon').props.style);
  // 筛选按钮与左右切换按钮的图标中心都在 y=20：40 高 + 居中对齐才对齐。
  expect(style.height).toBe(40);
});

test('非同步状态下图标不保留旋转角度', async () => {
  await render(<SyncStatusIcon />);

  expect(screen.getByTestId('sync_status_icon_spin').props.style.transform).toBeUndefined();
});

test('同步中才带旋转角度', async () => {
  getSyncStateMock.mockReturnValue({ kind: 'syncing', phase: 'push' });

  await render(<SyncStatusIcon />);

  const { transform } = screen.getByTestId('sync_status_icon_spin').props.style;
  expect(transform).toHaveLength(1);
});

test('同步中按下立即同步不会触发同步', async () => {
  getSyncStateMock.mockReturnValue({ kind: 'syncing', phase: 'push' });

  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));
  await fireEvent.press(screen.getByTestId('sync_tooltip_sync_now'));

  expect(requestSyncMock).not.toHaveBeenCalled();
});

test('气泡本体声明为触摸响应者，避免点卡片时关闭', async () => {
  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));

  expect(screen.getByTestId('sync_tooltip').props.onStartShouldSetResponder()).toBe(true);
});

test('页面失焦时关闭气泡', async () => {
  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));
  expect(screen.getByTestId('sync_tooltip')).toBeTruthy();

  await act(async () => {
    mockBlurHandlers.forEach((handler) => handler());
  });

  expect(screen.queryByTestId('sync_tooltip')).toBeNull();
});

test('无障碍：图标 label 带操作提示，气泡与遮罩有语义', async () => {
  await render(<SyncStatusIcon />);

  const icon = screen.getByTestId('sync_status_icon');
  expect(icon.props.accessibilityLabel).toContain('已同步');
  expect(icon.props.accessibilityLabel).toContain('查看同步详情');

  await fireEvent.press(icon);

  expect(screen.getByTestId('sync_tooltip').props.accessibilityViewIsModal).toBe(true);
  expect(screen.getByTestId('sync_tooltip_backdrop').props.accessibilityRole).toBe('button');
});

test('按钮文案允许缩小，避免长语言被截断', async () => {
  useSyncSummaryMock.mockReturnValue({ ...base, problems: 1 });

  await render(<SyncStatusIcon />);
  await fireEvent.press(screen.getByTestId('sync_status_icon'));

  expect(screen.getByText('立即同步').props.adjustsFontSizeToFit).toBe(true);
  expect(screen.getByText('查看需处理项').props.adjustsFontSizeToFit).toBe(true);
});

test('iOS 上先关气泡，dismiss 后才打开失败项列表', async () => {
  useSyncSummaryMock.mockReturnValue({ ...base, problems: 1 });
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });

  try {
    await render(<SyncStatusIcon />);
    await fireEvent.press(screen.getByTestId('sync_status_icon'));

    jest.useFakeTimers();
    await fireEvent.press(screen.getByTestId('sync_tooltip_issues'));

    // 同一帧里不许再 present 第二个 Modal：必须等气泡 dismiss 之后再打开。
    expect(screen.queryByText('issue-list-open')).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    expect(screen.queryByText('issue-list-open')).toBeTruthy();
  } finally {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  }
});
