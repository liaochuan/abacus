import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import axios from 'axios';

import AutocompleteField from '../AutocompleteField';
import { APressable } from '../../../UI/ALibrary';
import { readAutocomplete } from '../../../../db/autocomplete';
import type { AutocompleteOption } from '../../../../db/autocomplete';

// 组件层验证：offline 分支只读缓存、不发网络；online 分支保持原来的远端行为。
// 缓存模块的读/过滤细节由 src/db/__tests__/autocomplete.test.ts 覆盖，这里只替换数据入口。

jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

jest.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) => selector({
    configuration: { backendURL: 'https://firefly.test', selectedBrandStyle: '#000000' },
  }),
}));

jest.mock('../../../../i18n/locale', () => ({
  __esModule: true,
  default: (key: string) => key,
}));

jest.mock('../../../../db/instance', () => ({
  getDb: () => ({}),
}));

jest.mock('../../../../db/scope', () => ({
  getCurrentScope: async () => 'scope1',
}));

jest.mock('../../../../db/autocomplete', () => {
  const actual = jest.requireActual('../../../../db/autocomplete');
  return { __esModule: true, ...actual, readAutocomplete: jest.fn() };
});

const readAutocompleteMock = readAutocomplete as jest.MockedFunction<typeof readAutocomplete>;
const axiosGetMock = axios.get as jest.Mock;

const option = (name: string, id = '', type?: string): AutocompleteOption => ({ id, name, type });

const renderedText = (tree: ReactTestRenderer): string[] => tree.root
  .findAllByType(Text)
  .map((node) => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children ?? '')));

const renderField = async (props: Record<string, unknown>): Promise<ReactTestRenderer> => {
  let tree: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AutocompleteField
        routeApi="accounts"
        label="Source account"
        placeholder="Account"
        value=""
        onSelectAutocomplete={jest.fn()}
        {...props}
      />,
    );
  });
  return tree!;
};

const inputOf = (tree: ReactTestRenderer) => tree.root.findAllByType(TextInput)[0];

const focusInput = async (tree: ReactTestRenderer): Promise<void> => {
  const input = inputOf(tree);
  await act(async () => {
    input.props.onFocus({ nativeEvent: { text: '' } });
  });
};

const changeText = async (tree: ReactTestRenderer, text: string): Promise<void> => {
  const input = inputOf(tree);
  await act(async () => {
    input.props.onChangeText(text);
  });
};

beforeEach(() => {
  readAutocompleteMock.mockReset();
  readAutocompleteMock.mockResolvedValue([]);
  axiosGetMock.mockReset();
});

test('offline 时只读当前 scope 的缓存，展示候选且不调用网络', async () => {
  readAutocompleteMock.mockResolvedValue([
    option('Cash', '1'),
    option('Bank', '2'),
    option('cash wallet', '3'),
    option('Credit', '4'),
  ]);
  const tree = await renderField({ offline: true });

  await focusInput(tree);

  expect(readAutocompleteMock).toHaveBeenCalledWith(expect.anything(), 'scope1', 'accounts');
  expect(axiosGetMock).not.toHaveBeenCalled();
  expect(renderedText(tree)).toEqual(expect.arrayContaining(['Cash', 'Bank', 'cash wallet', 'Credit']));
});

test('offline 时输入文本按本地规则过滤候选', async () => {
  readAutocompleteMock.mockResolvedValue([
    option('Cash', '1'),
    option('Bank', '2'),
    option('cash wallet', '3'),
    option('Credit', '4'),
  ]);
  const tree = await renderField({ offline: true });
  await focusInput(tree);

  await changeText(tree, 'ca');

  const texts = renderedText(tree);
  expect(texts).toEqual(expect.arrayContaining(['Cash', 'cash wallet']));
  expect(texts).not.toContain('Bank');
  expect(texts).not.toContain('Credit');
  expect(axiosGetMock).not.toHaveBeenCalled();
});

test('offline 且账户缓存为空时展示离线提示', async () => {
  readAutocompleteMock.mockResolvedValue([]);
  const tree = await renderField({ offline: true });

  await focusInput(tree);

  expect(renderedText(tree)).toContain('offline_no_accounts');
});

test('offline 缓存非空但输入无匹配时，不误报“没有缓存的账户”', async () => {
  readAutocompleteMock.mockResolvedValue([option('Cash', '1'), option('Bank', '2')]);
  const tree = await renderField({ offline: true });
  await focusInput(tree);

  await changeText(tree, 'zzz');

  const texts = renderedText(tree);
  expect(texts).not.toContain('Cash');
  expect(texts).not.toContain('offline_no_accounts');
});

test('offline 且其他实体缓存为空时不展示账户提示', async () => {
  readAutocompleteMock.mockResolvedValue([]);
  const tree = await renderField({ offline: true, routeApi: 'categories' });

  await focusInput(tree);

  expect(renderedText(tree)).not.toContain('offline_no_accounts');
});

test('offline 选中候选时把真实 id 交给 onSelectAutocomplete', async () => {
  readAutocompleteMock.mockResolvedValue([option('Cash', 'acc-1')]);
  const onSelect = jest.fn();
  const tree = await renderField({ offline: true, onSelectAutocomplete: onSelect });
  await focusInput(tree);

  const pressable = tree.root.findAllByType(APressable)[0];
  await act(async () => {
    pressable.props.onPress();
  });

  expect(onSelect).toHaveBeenCalledWith({ id: 'acc-1', name: 'Cash' });
});

test('offline 账户列表沿用线上 types 过滤，旧缓存缺 type 时保留', async () => {
  readAutocompleteMock.mockResolvedValue([
    option('Asset A', '1', 'Asset account'),
    option('Expense E', '2', 'Expense account'),
    option('Loan L', '3', 'Loan'),
    { id: '4', name: 'Legacy account' } as AutocompleteOption,
  ]);
  const tree = await renderField({ offline: true });

  await focusInput(tree);

  const texts = renderedText(tree);
  expect(texts).toEqual(expect.arrayContaining(['Asset A', 'Loan L', 'Legacy account']));
  expect(texts).not.toContain('Expense E');
});

test('offline 在一次聚焦内只读一次 blob，后续击键只做内存过滤', async () => {
  readAutocompleteMock.mockResolvedValue([option('Cash', '1'), option('cash wallet', '2')]);
  const tree = await renderField({ offline: true });

  await focusInput(tree);
  await changeText(tree, 'ca');
  await changeText(tree, 'cash');

  expect(readAutocompleteMock).toHaveBeenCalledTimes(1);
  expect(renderedText(tree)).toContain('Cash');
});

test('offline 慢读期间连续击键不会重复读取 blob', async () => {
  let resolveRead: (options: AutocompleteOption[]) => void = () => {};
  readAutocompleteMock.mockReturnValue(new Promise((resolve) => { resolveRead = resolve; }));
  const tree = await renderField({ offline: true });

  const input = inputOf(tree);
  await act(async () => {
    input.props.onFocus({ nativeEvent: {} });
  });
  await changeText(tree, 'ca');

  expect(readAutocompleteMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveRead([option('Cash', '1'), option('Bank', '2')]);
  });

  expect(readAutocompleteMock).toHaveBeenCalledTimes(1);
  expect(renderedText(tree)).toContain('Cash');
  expect(renderedText(tree)).not.toContain('Bank');
});

test('未传 offline 时保持远端请求行为', async () => {
  axiosGetMock.mockResolvedValue({ data: [{ id: '1', name: 'Remote account' }] });
  const tree = await renderField({});

  await focusInput(tree);

  expect(axiosGetMock).toHaveBeenCalledTimes(1);
  expect(String(axiosGetMock.mock.calls[0][0])).toBe(
    'https://firefly.test/api/v1/autocomplete/accounts?limit=10&types=Asset%20account,Loan,Debt,Mortgage&query=',
  );
  expect(readAutocompleteMock).not.toHaveBeenCalled();
  expect(renderedText(tree)).toContain('Remote account');
});

test('远端请求乱序返回时只展示最后一次查询的结果', async () => {
  let resolveFirst: (value: unknown) => void = () => {};
  let resolveSecond: (value: unknown) => void = () => {};
  axiosGetMock
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
  const tree = await renderField({});

  await focusInput(tree);
  await changeText(tree, 'ca');

  await act(async () => {
    resolveSecond({ data: [{ id: '2', name: 'Second result' }] });
  });
  await act(async () => {
    resolveFirst({ data: [{ id: '1', name: 'First result' }] });
  });

  const texts = renderedText(tree);
  expect(texts).toContain('Second result');
  expect(texts).not.toContain('First result');
});
