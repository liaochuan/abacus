import React from 'react';
import { Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';

import TransactionDetailScreen from '../TransactionDetailScreen';
import { emitSyncChanged } from '../../../db/syncState';
import { getTransaction } from '../../../db/repository';
import { getCurrentScope } from '../../../db/scope';

jest.mock('../../../i18n/locale', () => ({
  __esModule: true,
  default: (key: string) => key,
}));

// ErrorWidget 会连带加载 react-redux（未在本项目 transformIgnorePatterns 内）。
jest.mock('react-redux', () => ({
  useSelector: () => null,
  useDispatch: () => ({ configuration: { resetError: jest.fn() } }),
}));

jest.mock('../../../db/instance', () => {
  const db = { name: 'fake-db' };
  return { getDb: () => db };
});
jest.mock('../../../db/scope', () => ({
  getCurrentScope: jest.fn(async () => 'scope-a'),
}));
jest.mock('../../../db/repository', () => ({
  getTransaction: jest.fn(async () => null),
}));

// 表单本身由 Forms 的测试覆盖：这里只验证详情页交给它的是最新基线。
jest.mock('../../Forms/TransactionForm', () => {
  const ReactLib = jest.requireActual('react');
  const ReactNative = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ id, baseUpdatedAt, title }: { id: string; baseUpdatedAt: string | null; title: string }) => ReactLib.createElement(
      ReactNative.View,
      null,
      ReactLib.createElement(ReactNative.Text, null, `${id}|${baseUpdatedAt ?? 'null'}|${title}`),
    ),
  };
});

const getTransactionMock = getTransaction as jest.MockedFunction<typeof getTransaction>;
const getCurrentScopeMock = getCurrentScope as jest.MockedFunction<typeof getCurrentScope>;

const buildRecord = (id: string, groupTitle: string, serverUpdatedAt: string | null) => ({
  id,
  payload: {
    id,
    type: 'transactions',
    attributes: {
      groupTitle,
      transactions: [{
        type: 'withdrawal',
        description: groupTitle,
        amount: '10.00',
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
  occurredAt: '2026-11-04T10:00:00+08:00',
  serverUpdatedAt,
  dirty: false,
});

const renderScreen = async (id: string) => {
  const navigation = {
    dispatch: jest.fn(),
    navigate: jest.fn(),
    setOptions: jest.fn(),
    goBack: jest.fn(),
  };
  const route = {
    key: 'detail',
    name: 'TransactionDetailScreen',
    params: {
      id,
      payload: { groupTitle: '导航标题', splits: [] },
    },
  };
  return render(
    <NavigationContainer>
      <TransactionDetailScreen navigation={navigation as any} route={route as any} />
    </NavigationContainer>,
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  getCurrentScopeMock.mockResolvedValue('scope-a');
  getTransactionMock.mockResolvedValue(null);
});

test('同步事件后重读本地记录，提交基线不会停在旧值', async () => {
  getTransactionMock.mockResolvedValueOnce(buildRecord('tx-1', '旧标题', '2026-11-01T00:00:00Z') as any);
  getTransactionMock.mockResolvedValueOnce(buildRecord('tx-1', '新标题', '2026-11-04T00:00:00Z') as any);

  const view = await renderScreen('tx-1');

  await waitFor(() => expect(view.getByText('tx-1|2026-11-01T00:00:00Z|旧标题')).toBeTruthy());
  expect(getTransactionMock).toHaveBeenCalledTimes(1);

  // 同步可能把服务端版本写回本地（换 id / 刷新基线）：详情页必须重新读一次。
  await act(async () => {
    emitSyncChanged();
  });

  await waitFor(() => expect(getTransactionMock).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(view.getByText('tx-1|2026-11-04T00:00:00Z|新标题')).toBeTruthy());
});
