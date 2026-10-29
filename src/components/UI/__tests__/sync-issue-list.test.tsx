import { Alert } from 'react-native';
import {
  act, fireEvent, render, screen, waitFor,
} from '@testing-library/react-native';

import SyncIssueList from '../SyncIssueList';
import { dropOutboxItem, listIssues, retryOutboxItem } from '../../../db/outbox';
import type { OutboxItem } from '../../../db/outbox';
import { requestSync } from '../../../lib/syncScheduler';

// 文案断言用 zh-CN 的真实词条：组件只负责选 key，词条完整性由 i18n 测试覆盖。
jest.mock('../../../i18n/locale', () => {
  const zhCN = jest.requireActual('../../../i18n/locale/translations/zh-CN').default as Record<string, string>;
  return {
    __esModule: true,
    default: (key: string, options?: { count?: number }) => String(zhCN[key] ?? key)
      .replace('%{count}', String(options?.count ?? '')),
  };
});

// ALibrary 的 index 会连带加载 AButton（react-redux 未在本项目的 transformIgnorePatterns 内）。
jest.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) => selector({
    configuration: { selectedBrandStyle: '#000000' },
  }),
}));

jest.mock('../../../db/instance', () => ({ getDb: () => ({}) }));
jest.mock('../../../db/scope', () => ({ getCurrentScope: async () => 'scope-a' }));

// issueLabel 保留真实实现：原因映射是 db 测试覆盖的契约，这里只验证组件把它翻成文案。
jest.mock('../../../db/outbox', () => {
  const actual = jest.requireActual('../../../db/outbox');
  return {
    __esModule: true,
    ...actual,
    listIssues: jest.fn(),
    retryOutboxItem: jest.fn(),
    dropOutboxItem: jest.fn(),
  };
});

// emitSyncChanged / subscribeSyncChanged 保留真实实现：重试与放弃后列表要真的重读。
jest.mock('../../../lib/syncScheduler', () => ({
  __esModule: true,
  requestSync: jest.fn(() => Promise.resolve()),
}));

const listIssuesMock = listIssues as jest.MockedFunction<typeof listIssues>;
const retryOutboxItemMock = retryOutboxItem as jest.MockedFunction<typeof retryOutboxItem>;
const dropOutboxItemMock = dropOutboxItem as jest.MockedFunction<typeof dropOutboxItem>;
const requestSyncMock = requestSync as jest.MockedFunction<typeof requestSync>;

const issue = (over: Partial<OutboxItem> = {}): OutboxItem => ({
  id: 'o1',
  op: 'update',
  entityId: '42',
  baseUpdatedAt: '2026-10-01T00:00:00Z',
  payload: {
    id: '42',
    type: 'transactions',
    attributes: {
      groupTitle: 'Lunch',
      transactions: [{ date: '2026-10-20', description: 'Pizza', amount: '12' }],
      user: '',
      createdAt: '',
      updatedAt: '',
    },
  } as any,
  status: 'failed',
  attempts: 5,
  lastError: '422',
  createdAt: '2026-10-01T00:00:00Z',
  ...over,
});

const renderList = async () => render(<SyncIssueList visible onClose={jest.fn()} />);

beforeEach(() => {
  jest.clearAllMocks();
  listIssuesMock.mockResolvedValue([issue()]);
  retryOutboxItemMock.mockResolvedValue(undefined);
  dropOutboxItemMock.mockResolvedValue(undefined);
});

test('列出失败项的描述、日期与原因', async () => {
  await renderList();

  await waitFor(() => expect(screen.getByTestId('sync_issue_row_o1')).toBeTruthy());
  expect(listIssuesMock).toHaveBeenCalledWith(expect.anything(), 'scope-a');
  expect(screen.getByText('Lunch: Pizza')).toBeTruthy();
  expect(screen.getByText('2026-10-20')).toBeTruthy();
  expect(screen.getByText('需要修正后才能同步')).toBeTruthy();
  expect(screen.getByText('重试')).toBeTruthy();
  expect(screen.getByText('放弃本地改动')).toBeTruthy();
});

test('没有失败项时显示空态', async () => {
  listIssuesMock.mockResolvedValue([]);
  await renderList();

  await waitFor(() => expect(screen.getByTestId('sync_issue_empty')).toBeTruthy());
  expect(screen.getByText('没有需要处理的项')).toBeTruthy();
  expect(screen.queryByTestId('sync_issue_row_o1')).toBeNull();
});

test('不同失败原因使用各自的文案', async () => {
  listIssuesMock.mockResolvedValue([
    issue({ id: 'o1', lastError: '404' }),
    issue({ id: 'o2', lastError: 'network' }),
  ]);
  await renderList();

  await waitFor(() => expect(screen.getByTestId('sync_issue_row_o2')).toBeTruthy());
  expect(screen.getByText('已在服务端删除')).toBeTruthy();
  expect(screen.getByText('等待网络恢复')).toBeTruthy();
});

test('404 只提供放弃入口，不提供永远失败的重试', async () => {
  listIssuesMock.mockResolvedValue([issue({ lastError: '404' })]);
  await renderList();

  await waitFor(() => expect(screen.getByTestId('sync_issue_row_o1')).toBeTruthy());
  expect(screen.getByText('已在服务端删除')).toBeTruthy();
  expect(screen.queryByTestId('sync_issue_retry_o1')).toBeNull();
  expect(screen.getByTestId('sync_issue_drop_o1')).toBeTruthy();
  expect(screen.getByText('放弃本地改动')).toBeTruthy();
});

test('读取失败时显示错误与重试入口，不显示空态', async () => {
  listIssuesMock.mockRejectedValueOnce(new Error('db down'));
  await renderList();

  await waitFor(() => expect(screen.getByTestId('sync_issue_error')).toBeTruthy());
  expect(screen.getByText('无法读取交易')).toBeTruthy();
  expect(screen.queryByTestId('sync_issue_empty')).toBeNull();

  // 重试走同一套 load：成功后错误消失，恢复正常空态。
  listIssuesMock.mockResolvedValue([]);
  await fireEvent.press(screen.getByTestId('sync_issue_reload'));

  await waitFor(() => expect(screen.getByTestId('sync_issue_empty')).toBeTruthy());
  expect(screen.queryByTestId('sync_issue_error')).toBeNull();
  expect(listIssuesMock).toHaveBeenCalledTimes(2);
});

test('重试：回到 pending、广播变化并唤醒一轮同步', async () => {
  await renderList();
  await waitFor(() => expect(screen.getByTestId('sync_issue_row_o1')).toBeTruthy());

  // 重试后该行不再是 failed：第二次读取返回空列表，行应当消失。
  listIssuesMock.mockResolvedValue([]);
  await fireEvent.press(screen.getByTestId('sync_issue_retry_o1'));

  await waitFor(() => expect(retryOutboxItemMock).toHaveBeenCalledWith(expect.anything(), 'o1'));
  expect(listIssuesMock).toHaveBeenCalledTimes(2);
  expect(requestSyncMock).toHaveBeenCalledWith('manual');
  await waitFor(() => expect(screen.getByTestId('sync_issue_empty')).toBeTruthy());
});

test('放弃前需要二次确认，取消时不删除', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await renderList();
  await waitFor(() => expect(screen.getByTestId('sync_issue_row_o1')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('sync_issue_drop_o1'));

  expect(alertSpy).toHaveBeenCalledTimes(1);
  const [title, message, buttons] = alertSpy.mock.calls[0];
  expect(title).toBe('放弃这些本地改动？');
  expect(message).toBe('Lunch: Pizza');

  // 取消分支没有 onPress 之外的副作用：点取消不调用 dropOutboxItem。
  await act(async () => {
    buttons?.[0]?.onPress?.();
  });
  expect(dropOutboxItemMock).not.toHaveBeenCalled();
});

test('确认放弃后删除失败项并刷新列表', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await renderList();
  await waitFor(() => expect(screen.getByTestId('sync_issue_row_o1')).toBeTruthy());

  listIssuesMock.mockResolvedValue([]);
  await fireEvent.press(screen.getByTestId('sync_issue_drop_o1'));

  const buttons = alertSpy.mock.calls[0][2];
  await act(async () => {
    buttons?.[1]?.onPress?.();
  });

  await waitFor(() => expect(dropOutboxItemMock).toHaveBeenCalledWith(
    expect.anything(),
    'scope-a',
    expect.objectContaining({ id: 'o1' }),
  ));
  await waitFor(() => expect(screen.getByTestId('sync_issue_empty')).toBeTruthy());
  expect(retryOutboxItemMock).not.toHaveBeenCalled();
});
