import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';

import TransactionsScreen from '../TransactionsScreen';
import { emitSyncChanged } from '../../../db/syncState';
import { listTransactions } from '../../../db/repository';
import { getCurrentScope } from '../../../db/scope';

// 组件只负责选 key，词条完整性由 i18n 测试覆盖。
jest.mock('../../../i18n/locale', () => {
  const zhCN = jest.requireActual('../../../i18n/locale/translations/zh-CN').default as Record<string, string>;
  return {
    __esModule: true,
    default: (key: string) => String(zhCN[key] ?? key),
  };
});

// 交易列表页本身不读 redux state，只有删除/报错路径会 dispatch。
jest.mock('react-redux', () => {
  const dispatch = {
    transactions: { deleteTransaction: jest.fn(async () => {}) },
    configuration: { reportError: jest.fn(async () => {}) },
  };
  return {
    useSelector: (selector: (state: unknown) => unknown) => selector({ configuration: {}, firefly: {} }),
    useDispatch: () => dispatch,
    __dispatch: dispatch,
  };
});

jest.mock('../../../db/instance', () => {
  const db = { name: 'fake-db' };
  return { getDb: () => db, __db: db };
});
jest.mock('../../../db/scope', () => ({
  getCurrentScope: jest.fn(async () => 'scope-a'),
}));
jest.mock('../../../db/repository', () => ({
  listTransactions: jest.fn(async () => []),
  deleteLocalTransaction: jest.fn(async () => {}),
}));
jest.mock('../../../lib/syncScheduler', () => ({
  requestSync: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../../lib/useOnlineGuard', () => ({
  useOnlineGuard: () => ({ online: true, guard: (action: () => void) => { action(); return true; } }),
}));

// 只保留列表需要的渲染路径：header、各 section 的 item 与 footer。
jest.mock('react-native-swipe-list-view', () => {
  const ReactLib = jest.requireActual('react');
  const ReactNative = jest.requireActual('react-native');
  return {
    SwipeListView: ({
      sections,
      renderItem,
      keyExtractor,
      ListHeaderComponent,
      ListFooterComponent,
    }: {
      sections: { data: unknown[] }[];
      renderItem: (info: { item: unknown; index: number; section: unknown }) => React.ReactElement;
      keyExtractor: (item: unknown) => string;
      ListHeaderComponent?: React.ReactElement;
      ListFooterComponent?: React.ReactElement;
    }) => ReactLib.createElement(
      ReactNative.View,
      null,
      ListHeaderComponent,
      ...sections.flatMap((section) => section.data.map((item, index) => ReactLib.createElement(
        ReactNative.View,
        { key: keyExtractor(item) },
        renderItem({ item, index, section }),
      ))),
      ListFooterComponent,
    ),
  };
});

const listTransactionsMock = listTransactions as jest.MockedFunction<typeof listTransactions>;
const getCurrentScopeMock = getCurrentScope as jest.MockedFunction<typeof getCurrentScope>;

const buildRecord = (id: string, description: string) => ({
  id,
  payload: {
    id,
    type: 'transactions',
    attributes: {
      groupTitle: '',
      transactions: [{
        type: 'withdrawal',
        description,
        amount: '12.50',
        currencyCode: 'CNY',
        sourceName: '现金',
        destinationName: '超市',
        date: '2026-11-04T10:00:00+08:00',
        categoryName: '',
        tags: [],
      }],
      user: '',
      createdAt: '',
      updatedAt: '',
    },
  },
});

const existingRecord = buildRecord('local-1', '已有交易');
const freshRecord = buildRecord('local-2', '刚保存的交易');

const renderScreen = async () => {
  const navigation = {
    dispatch: jest.fn(),
    navigate: jest.fn(),
    setOptions: jest.fn(),
    setParams: jest.fn(),
  };
  const route = {
    key: 'transactions',
    name: 'TransactionsScreen',
    params: { forceRefresh: false },
  };
  const view = await render(
    <NavigationContainer>
      <TransactionsScreen navigation={navigation as any} route={route as any} />
    </NavigationContainer>,
  );
  return view;
};

beforeEach(() => {
  jest.clearAllMocks();
  getCurrentScopeMock.mockResolvedValue('scope-a');
  listTransactionsMock.mockResolvedValue([]);
});

test('同步事件后重查本地列表，且刷新期间不清空已有列表', async () => {
  let resolveSecondPage: (records: unknown[]) => void = () => {};
  const secondPage = new Promise<unknown[]>((resolve) => {
    resolveSecondPage = resolve;
  });
  listTransactionsMock.mockResolvedValueOnce([existingRecord as any]);
  listTransactionsMock.mockReturnValueOnce(secondPage as any);

  const view = await renderScreen();

  await waitFor(() => expect(listTransactionsMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(view.getByText('已有交易')).toBeTruthy());

  // 保存交易与同步完成都会广播这个事件：列表应当自己重读，而不是等下拉刷新。
  await act(async () => {
    emitSyncChanged();
  });

  expect(listTransactionsMock).toHaveBeenCalledTimes(2);
  // 静默刷新：第二次查询还没返回时，旧列表必须还在（不能闪成空列表）。
  expect(view.getByText('已有交易')).toBeTruthy();

  await act(async () => {
    resolveSecondPage([existingRecord as any, freshRecord as any]);
  });

  await waitFor(() => expect(view.getByText('刚保存的交易')).toBeTruthy());
  expect(view.getByText('已有交易')).toBeTruthy();
});
