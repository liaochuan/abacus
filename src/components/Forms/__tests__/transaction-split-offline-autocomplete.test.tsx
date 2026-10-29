import React from 'react';
import { act, create } from 'react-test-renderer';

import TransactionSplitForm from '../TransactionSplitForm';

// 组件层验证阻断项：交易表单的 7 个自动补全都必须跟着连接状态走。
// 离线时把 offline 传给 AutocompleteField，否则表单仍会发网络请求。

const mockNetwork = { online: true };
const mockAutocompleteProps: Array<Record<string, unknown>> = [];

jest.mock('../../../lib/network', () => ({
  __esModule: true,
  isOnline: () => mockNetwork.online,
  subscribeNetwork: () => () => {},
}));

// 把自动补全换成记录 props 的空组件：本测试只关心 offline 是否传到每一处。
jest.mock('../Fields/AutocompleteField', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockAutocompleteProps.push(props);
    return null;
  },
}));

jest.mock('../Fields/ForeignCurrencyField', () => ({ __esModule: true, default: () => null }));

jest.mock('../../../models/transactions', () => ({
  __esModule: true,
  types: [{ type: 'withdrawal', keyName: 'withdrawal' }],
}));

jest.mock('react-redux', () => ({
  useDispatch: () => jest.fn(),
  useSelector: (selector: (state: unknown) => unknown) => selector({
    configuration: { displayForeignCurrency: false, selectedBrandStyle: '#000000' },
  }),
}));

jest.mock('../../../i18n/locale', () => ({ __esModule: true, default: (key: string) => key }));

jest.mock('../../../lib/common', () => ({
  __esModule: true,
  useThemeColors: () => ({ colorScheme: 'light', colors: new Proxy({}, { get: () => '#000000' }) }),
}));

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en', languageTag: 'en-US' }] }));

jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(() => Promise.resolve()) }));

jest.mock('@react-native-community/datetimepicker', () => ({ __esModule: true, default: () => null }));

const split = {
  type: 'withdrawal',
  date: '2026-10-01T00:00:00Z',
  amount: '10.00',
  foreignAmount: '',
  currencyCode: 'CNY',
  currencySymbol: '¥',
  description: '',
  sourceName: '',
  sourceId: null,
  destinationName: '',
  destinationId: null,
  categoryId: '',
  categoryName: '',
  budgetId: '',
  budgetName: '',
  billId: '',
  billName: '',
  foreignCurrencyId: '',
  foreignCurrencyCode: '',
  tags: [],
  notes: '',
};

const renderForm = async (): Promise<void> => {
  mockAutocompleteProps.length = 0;
  await act(async () => {
    create(
      <TransactionSplitForm
        index={0}
        total={1}
        isNew
        handleDelete={jest.fn()}
        transaction={split}
      />,
    );
  });
};

test('在线时 7 个自动补全都不走离线缓存', async () => {
  mockNetwork.online = true;

  await renderForm();

  expect(mockAutocompleteProps).toHaveLength(7);
  expect(mockAutocompleteProps.every((props) => props.offline === false)).toBe(true);
});

test('离线时 7 个自动补全都切到离线缓存', async () => {
  mockNetwork.online = false;

  await renderForm();

  expect(mockAutocompleteProps).toHaveLength(7);
  expect(mockAutocompleteProps.every((props) => props.offline === true)).toBe(true);
});
