import {
  act, fireEvent, render, screen, waitFor,
} from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import SyncNoticeModal from '../SyncNoticeModal';
import { acknowledgeNotice, listOpenNotices } from '../../../db/notices';
import type { NoticeRow } from '../../../db/notices';
import { getMeta, setMeta } from '../../../db/repository';
import { readSyncSummary } from '../../../db/useSyncSummary';
import { getSyncState } from '../../../db/syncState';
import { isOnline } from '../../../lib/network';

// 文案断言用 zh-CN 的真实词条：组件只负责选 key，词条完整性由 i18n 测试覆盖。
jest.mock('../../../i18n/locale', () => {
  const zhCN = jest.requireActual('../../../i18n/locale/translations/zh-CN').default as Record<string, string>;
  return {
    __esModule: true,
    default: (key: string, options?: { count?: number }) => String(zhCN[key] ?? key)
      .replace('%{count}', String(options?.count ?? '')),
  };
});

// ALibrary 的 index 会连带加载 AButton（react-redux 未在 transformIgnorePatterns 内）。
jest.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) => selector({
    configuration: { selectedBrandStyle: '#000000' },
  }),
}));

// 库与 scope 只提供「有连接、有一个 scope」；notices 的两条读写在下面用 mock 控制，
// diffTransaction 保留真实实现，这样冲突表的取值由真实逻辑决定。
// tx 直接执行回调：连接告警的确认要在一个事务里写两条 meta。
jest.mock('../../../db/instance', () => ({
  getDb: () => ({ tx: async (fn: () => Promise<void>) => fn() }),
}));
jest.mock('../../../db/scope', () => ({ getCurrentScope: async () => 'scope-a' }));

jest.mock('../../../db/notices', () => {
  const actual = jest.requireActual('../../../db/notices');
  return {
    __esModule: true,
    ...actual,
    listOpenNotices: jest.fn(),
    acknowledgeNotice: jest.fn(),
  };
});

// meta 读写与摘要单独替身：连接告警的判定依赖它们，且不能被 db 替身干扰。
jest.mock('../../../db/repository', () => ({
  __esModule: true,
  getMeta: jest.fn(),
  setMeta: jest.fn(),
}));

jest.mock('../../../db/useSyncSummary', () => ({
  __esModule: true,
  readSyncSummary: jest.fn(),
}));

// 只替换 getSyncState：subscribeSyncChanged / emitSyncChanged 保留真实实现，
// 这样「关闭 → 广播 → 重读」的闭环与生产一致。
jest.mock('../../../db/syncState', () => {
  const actual = jest.requireActual('../../../db/syncState');
  return {
    __esModule: true,
    ...actual,
    getSyncState: jest.fn(),
  };
});

jest.mock('../../../lib/network', () => ({
  __esModule: true,
  isOnline: jest.fn(() => true),
  subscribeNetwork: jest.fn(() => jest.fn()),
}));

const listOpenNoticesMock = listOpenNotices as jest.MockedFunction<typeof listOpenNotices>;
const acknowledgeNoticeMock = acknowledgeNotice as jest.MockedFunction<typeof acknowledgeNotice>;
const getMetaMock = getMeta as jest.MockedFunction<typeof getMeta>;
const setMetaMock = setMeta as jest.MockedFunction<typeof setMeta>;
const readSyncSummaryMock = readSyncSummary as jest.MockedFunction<typeof readSyncSummary>;
const getSyncStateMock = getSyncState as jest.MockedFunction<typeof getSyncState>;
const isOnlineMock = isOnline as jest.MockedFunction<typeof isOnline>;

const split = (over: Record<string, unknown> = {}) => ({
  description: 'a',
  amount: '1',
  date: '2026-10-01',
  type: 'withdrawal',
  categoryName: 'Food',
  budgetName: '',
  tags: [] as string[],
  notes: '',
  sourceName: 'Cash',
  destinationName: 'Shop',
  ...over,
});

const transaction = (groupTitle: string, splits: unknown[]) => ({
  id: 'e1',
  type: 'withdrawal',
  attributes: {
    groupTitle, transactions: splits, user: '', createdAt: '', updatedAt: '',
  },
} as any);

const conflictNotice: NoticeRow = {
  id: 'n1',
  kind: 'conflict',
  entityId: 'e1',
  localPayload: transaction('本地标题', [split()]),
  serverPayload: transaction('服务端标题', [split({ amount: '9' })]),
  detectedAt: '2026-10-01T00:00:00.000Z',
};

const deletionNotice: NoticeRow = {
  id: 'n2',
  kind: 'server_deletion',
  entityId: 'e2',
  localPayload: null,
  serverPayload: transaction('被删标题', [split({
    description: '午餐',
    amount: '12.50',
    currencyCode: 'CNY',
    categoryName: '餐饮',
    tags: ['报销'],
  })]),
  detectedAt: '2026-10-02T00:00:00.000Z',
};

beforeEach(() => {
  listOpenNoticesMock.mockReset();
  acknowledgeNoticeMock.mockReset();
  acknowledgeNoticeMock.mockResolvedValue(undefined);
  getMetaMock.mockReset();
  getMetaMock.mockResolvedValue(null);
  setMetaMock.mockReset();
  setMetaMock.mockResolvedValue(undefined);
  readSyncSummaryMock.mockReset();
  readSyncSummaryMock.mockResolvedValue({
    online: true, pending: 0, problems: 0, lastSyncedAt: null,
  });
  getSyncStateMock.mockReset();
  getSyncStateMock.mockReturnValue({
    kind: 'idle', lastSyncedAt: null, pending: 0, problems: 0,
  });
  isOnlineMock.mockReset();
  isOnlineMock.mockReturnValue(true);
});

test('没有未确认提示时不渲染弹窗', async () => {
  listOpenNoticesMock.mockResolvedValue([]);

  await render(<SyncNoticeModal />);

  await waitFor(() => expect(listOpenNoticesMock).toHaveBeenCalledWith(expect.anything(), 'scope-a'));
  expect(screen.queryByTestId('sync_notice_card')).toBeNull();
});

test('冲突提示渲染标题、本地/服务端两列与差异值', async () => {
  listOpenNoticesMock.mockResolvedValue([conflictNotice]);

  await render(<SyncNoticeModal />);

  expect(await screen.findByTestId('sync_notice_card')).toBeTruthy();
  expect(screen.getByText('交易冲突')).toBeTruthy();
  expect(screen.getByText('本地')).toBeTruthy();
  expect(screen.getByText('服务端')).toBeTruthy();
  // 组标题差异与金额差异都要出现，左右两侧是各自的原值。
  expect(screen.getByText('本地标题')).toBeTruthy();
  expect(screen.getByText('服务端标题')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.getByText('9')).toBeTruthy();
});

test('服务端删除提示渲染日期、描述、金额、账户、分类与标签', async () => {
  listOpenNoticesMock.mockResolvedValue([deletionNotice]);

  await render(<SyncNoticeModal />);

  expect(await screen.findByTestId('sync_notice_card')).toBeTruthy();
  expect(screen.getByText('已在服务端删除')).toBeTruthy();
  expect(screen.getByText('2026-10-01')).toBeTruthy();
  expect(screen.getByText('午餐')).toBeTruthy();
  expect(screen.getByText('12.50 CNY')).toBeTruthy();
  expect(screen.getByText('Cash → Shop')).toBeTruthy();
  expect(screen.getByText('餐饮')).toBeTruthy();
  expect(screen.getByText('报销')).toBeTruthy();
});

test('点「关闭」回填 acknowledged_at，列表清空后弹窗消失', async () => {
  listOpenNoticesMock
    .mockResolvedValueOnce([conflictNotice])
    .mockResolvedValue([]);

  await render(<SyncNoticeModal />);

  const closeButton = await screen.findByTestId('sync_notice_close_n1');
  await act(async () => {
    fireEvent.press(closeButton);
  });

  expect(acknowledgeNoticeMock).toHaveBeenCalledTimes(1);
  expect(acknowledgeNoticeMock).toHaveBeenCalledWith(expect.anything(), 'n1', 'scope-a');

  // 关闭后广播事件 → 组件重读列表 → notices 为空 → Modal 卸载。
  await waitFor(() => expect(screen.queryByTestId('sync_notice_card')).toBeNull());
});

test('确认失败时保留弹窗、显示错误并允许重试', async () => {
  listOpenNoticesMock
    .mockResolvedValueOnce([conflictNotice])
    .mockResolvedValue([]);
  acknowledgeNoticeMock
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValueOnce(undefined);

  await render(<SyncNoticeModal />);

  const closeButton = await screen.findByTestId('sync_notice_close_n1');
  await act(async () => {
    fireEvent.press(closeButton);
  });

  // 写失败不广播、不卸载：卡片仍在，错误行可见，按钮恢复可用。
  expect(acknowledgeNoticeMock).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('sync_notice_card')).toBeTruthy();
  expect(screen.getByTestId('sync_notice_error')).toBeTruthy();
  expect(screen.getByText('出错了')).toBeTruthy();
  expect(screen.getByTestId('sync_notice_close_n1').props.accessibilityState?.disabled).toBe(false);

  // 再点一次即可重试，成功后正常关闭。
  await act(async () => {
    fireEvent.press(screen.getByTestId('sync_notice_close_n1'));
  });

  expect(acknowledgeNoticeMock).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByTestId('sync_notice_card')).toBeNull());
});

test('关闭按钮有按钮语义、可读标签与至少 44 的触控高度，卡片限制 VoiceOver 范围', async () => {
  listOpenNoticesMock.mockResolvedValue([conflictNotice]);

  await render(<SyncNoticeModal />);

  const card = await screen.findByTestId('sync_notice_card');
  expect(card.props.accessibilityViewIsModal).toBe(true);

  const closeButton = screen.getByTestId('sync_notice_close_n1');
  expect(closeButton.props.accessibilityRole).toBe('button');
  expect(closeButton.props.accessibilityLabel).toBe('关闭');
  expect(StyleSheet.flatten(closeButton.props.style).height).toBeGreaterThanOrEqual(44);
});

// ---------------------------------------------------------------------------
// 连接异常告警（虚拟条目）

const DAY_MS = 24 * 60 * 60 * 1000;

// 用相对当前时间构造，避免测试依赖真实时钟：4 天前 → 3 档，8 天前 → 7 档。
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

const idleState = {
  kind: 'idle' as const,
  lastSyncedAt: null,
  pending: 0,
  problems: 0,
};

// meta 的读写用一个内存表串起来：关闭告警后重读能拿到刚写入的值，
// 才能断言「写入 → 广播 → 重读 → 条目消失」这条闭环。
const useMetaTable = (initial: Record<string, string | null> = {}) => {
  const table = new Map(Object.entries(initial));
  getMetaMock.mockImplementation(async (_db, _scope, key) => table.get(key) ?? null);
  setMetaMock.mockImplementation(async (_db, _scope, key, value) => {
    table.set(key, value);
  });
  return table;
};

test('离线且跨过 3 天档位时，连接告警排在最前并给出最后成功时间、错误与待上传数', async () => {
  useMetaTable({ last_sync_error: 'network' });
  listOpenNoticesMock.mockResolvedValue([conflictNotice]);
  isOnlineMock.mockReturnValue(false);
  getSyncStateMock.mockReturnValue(idleState);
  readSyncSummaryMock.mockResolvedValue({
    online: false,
    pending: 2,
    problems: 0,
    lastSyncedAt: daysAgo(4),
  });

  await render(<SyncNoticeModal />);

  const alert = await screen.findByTestId('sync_connection_alert');
  expect(alert).toBeTruthy();
  expect(screen.getByText('已 4 天未成功同步')).toBeTruthy();
  expect(screen.getByText('上次成功同步')).toBeTruthy();
  expect(screen.getByText('网络异常')).toBeTruthy();
  expect(screen.queryByText('network')).toBeNull();
  expect(screen.getByText('2 条待上传')).toBeTruthy();

  // 虚拟条目排在真实提示之前：testID 的返回顺序即树的顺序。
  const ordered = screen.getAllByTestId(/^(sync_connection_alert|sync_notice_close_n1)$/);
  expect(ordered[0].props.testID).toBe('sync_connection_alert');
  expect(ordered).toHaveLength(2);
});

test('在线且同步正常时不展示连接告警', async () => {
  listOpenNoticesMock.mockResolvedValue([]);
  readSyncSummaryMock.mockResolvedValue({
    online: true,
    pending: 0,
    problems: 0,
    lastSyncedAt: daysAgo(8),
  });

  await render(<SyncNoticeModal />);

  await waitFor(() => expect(listOpenNoticesMock).toHaveBeenCalled());
  expect(screen.queryByTestId('sync_connection_alert')).toBeNull();
  expect(screen.queryByTestId('sync_notice_card')).toBeNull();
  // 连接正常时连 meta 都不查：告警在这条路径上不可能出现。
  expect(readSyncSummaryMock).not.toHaveBeenCalled();
});

test('上一轮同步失败（error）时即使在线也展示告警', async () => {
  useMetaTable({ last_sync_error: 'auth' });
  listOpenNoticesMock.mockResolvedValue([]);
  getSyncStateMock.mockReturnValue({
    kind: 'error',
    reason: 'auth',
    message: 'sync failed',
    lastSyncedAt: null,
    pending: 0,
    problems: 0,
  });
  readSyncSummaryMock.mockResolvedValue({
    online: true,
    pending: 0,
    problems: 0,
    lastSyncedAt: daysAgo(8),
  });

  await render(<SyncNoticeModal />);

  expect(await screen.findByTestId('sync_connection_alert')).toBeTruthy();
  expect(screen.getByText('已 8 天未成功同步')).toBeTruthy();
  expect(screen.getByText('登录已过期')).toBeTruthy();
  expect(screen.queryByText('auth')).toBeNull();
});

test('关闭连接告警写入档位与确认时间，条目随后消失且不自动重弹', async () => {
  useMetaTable({ last_sync_error: 'server' });
  listOpenNoticesMock.mockResolvedValue([]);
  isOnlineMock.mockReturnValue(false);
  getSyncStateMock.mockReturnValue(idleState);
  readSyncSummaryMock.mockResolvedValue({
    online: false,
    pending: 0,
    problems: 0,
    lastSyncedAt: daysAgo(4),
  });

  await render(<SyncNoticeModal />);

  const closeButton = await screen.findByTestId('sync_connection_close');
  await act(async () => {
    fireEvent.press(closeButton);
  });

  expect(setMetaMock).toHaveBeenCalledWith(
    expect.anything(),
    'scope-a',
    'connection_alert_level',
    '3',
  );
  expect(setMetaMock).toHaveBeenCalledWith(
    expect.anything(),
    'scope-a',
    'connection_alert_acknowledged_at',
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
  );

  // 确认后广播 → 重读（同档位 24h 内不再提醒）→ 没有其它提示 → 弹窗卸载。
  await waitFor(() => expect(screen.queryByTestId('sync_notice_card')).toBeNull());
});

test('连接告警确认失败时保留条目并显示错误', async () => {
  useMetaTable();
  listOpenNoticesMock.mockResolvedValue([]);
  isOnlineMock.mockReturnValue(false);
  getSyncStateMock.mockReturnValue(idleState);
  readSyncSummaryMock.mockResolvedValue({
    online: false,
    pending: 0,
    problems: 0,
    lastSyncedAt: daysAgo(4),
  });
  setMetaMock.mockRejectedValue(new Error('disk full'));

  await render(<SyncNoticeModal />);

  const closeButton = await screen.findByTestId('sync_connection_close');
  await act(async () => {
    fireEvent.press(closeButton);
  });

  expect(screen.getByTestId('sync_connection_alert')).toBeTruthy();
  expect(screen.getByTestId('sync_notice_error')).toBeTruthy();
  expect(screen.getByTestId('sync_connection_close').props.accessibilityState?.disabled)
    .toBe(false);
});

test('未知错误分类回落到通用错误文案，不显示枚举原文', async () => {
  useMetaTable({ last_sync_error: 'mystery' });
  listOpenNoticesMock.mockResolvedValue([]);
  isOnlineMock.mockReturnValue(false);
  getSyncStateMock.mockReturnValue(idleState);
  readSyncSummaryMock.mockResolvedValue({
    online: false,
    pending: 0,
    problems: 0,
    lastSyncedAt: daysAgo(4),
  });

  await render(<SyncNoticeModal />);

  expect(await screen.findByTestId('sync_connection_alert')).toBeTruthy();
  // 标签与值都回落到 sync_status_error（zh-CN: 同步出错）。
  expect(screen.getAllByText('同步出错')).toHaveLength(2);
  expect(screen.queryByText('mystery')).toBeNull();
});

test('应用保持打开时，同档位满 24h 会再次提醒（60s 轮询刷新 now）', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-27T00:00:00Z'));
  try {
    useMetaTable({
      last_sync_error: 'network',
      connection_alert_level: '3',
      connection_alert_acknowledged_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    listOpenNoticesMock.mockResolvedValue([]);
    isOnlineMock.mockReturnValue(false);
    getSyncStateMock.mockReturnValue(idleState);
    readSyncSummaryMock.mockResolvedValue({
      online: false,
      pending: 0,
      problems: 0,
      lastSyncedAt: daysAgo(4),
    });

    await render(<SyncNoticeModal />);
    await act(async () => {});
    // 1 小时前刚确认过同档位 → 初始不提醒。
    expect(screen.queryByTestId('sync_connection_alert')).toBeNull();

    // 再常开 25 小时：没有同步/网络事件，只靠 60s 轮询推进 now。
    jest.setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000));
    await act(async () => {
      jest.advanceTimersByTime(60 * 1000);
    });

    expect(screen.getByTestId('sync_connection_alert')).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});
