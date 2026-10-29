// 旧 AsyncStorage 迁移：测试只覆盖纯映射 planLegacyMigration（Task 5 决策 5），
// migrateLegacyState 运行时由 Detox 验证。mock 掉 AsyncStorage，保证测试
// 既不触碰真实存储也不加载原生模块（legacyMigration.ts 顶层 import 它）。
// jest.mock 由 babel-plugin-jest-hoist 提升到 import 之前执行，写在下方仅为满足 import/first。
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  legacyMigrationAllowed,
  migrateLegacyState,
  parseLegacyRoot,
  planLegacyMigration,
} from '../legacyMigration';
import type { Db } from '../types';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));

test('把旧 firefly/categories 等映射成 blob 键', () => {
  const plan = planLegacyMigration({
    firefly: {
      rangeDetails: { start: '2026-01-01', end: '2026-03-31' },
      netWorth: [{ monetaryValue: '10' }],
      spentChart: [1],
      earnedChart: [2],
    },
    categories: { insightCategories: [{ id: '1' }], total: { id: 'total' }, perDay: { id: 'perday' } },
    currencies: { currentCode: 'CNY' },
  });
  const keys = plan.map((p) => p.key);
  expect(keys).toContain('summary:2026-01-01:2026-03-31:CNY');
  expect(keys).toContain('categories:2026-01-01:2026-03-31:CNY');
  expect(plan.find((p) => p.key.startsWith('summary:'))?.payload).toMatchObject({ netWorth: [{ monetaryValue: '10' }] });
});

test('缺字段时跳过而不抛错', () => {
  expect(planLegacyMigration({})).toEqual([]);
  expect(planLegacyMigration(null)).toEqual([]);
});

test('缺 start/end/code 时跳过需要它们的键，区间无关键照常迁移', () => {
  const plan = planLegacyMigration({
    firefly: { rangeDetails: {}, netWorth: [] },
    budgets: { data: [] },
    accounts: { accounts: [] },
    piggyBanks: { piggyBanks: [] },
    currencies: {},
  });
  expect(plan.map((p) => p.key)).toEqual(['piggy_banks', 'currencies']);
});

test('firefly 拆成 summary 与 chart:balance 两组 payload', () => {
  const plan = planLegacyMigration({
    firefly: {
      rangeDetails: { start: '2026-01-01', end: '2026-03-31' },
      netWorth: [{ monetaryValue: '1' }],
      spent: [],
      earned: [],
      balance: [{ label: 'spent' }],
      bills: { paid: null, unpaid: null },
      earnedChart: [{ x: 1, y: 2 }],
      spentChart: [{ x: 3, y: 4 }],
    },
    currencies: { currentCode: 'EUR' },
  });
  expect(plan.find((p) => p.key === 'chart:balance:2026-01-01:2026-03-31:EUR')?.payload)
    .toEqual({ earnedChart: [{ x: 1, y: 2 }], spentChart: [{ x: 3, y: 4 }] });
  expect(plan.find((p) => p.key === 'summary:2026-01-01:2026-03-31:EUR')?.payload)
    .toEqual({
      netWorth: [{ monetaryValue: '1' }],
      spent: [],
      earned: [],
      balance: [{ label: 'spent' }],
      bills: { paid: null, unpaid: null },
    });
});

test('categories/budgets/accounts/piggyBanks/bills/currencies 写内层数组且 accounts 用 asset 键', () => {
  const budgets = { budgets: [{ id: '4' }] };
  const accounts = { accounts: [{ id: '1' }], selectedAccountIds: [] };
  const piggyBanks = { piggyBanks: [{ id: '2' }] };
  const bills = { bills: [{ id: 'bill-1' }] };
  const currencies = { currentCode: 'CNY', data: [{ id: '3' }] };
  const plan = planLegacyMigration({
    firefly: { rangeDetails: { start: '2026-01-01', end: '2026-03-31' } },
    categories: { insightCategories: [], total: { id: 'total' }, perDay: undefined },
    budgets,
    accounts,
    piggyBanks,
    bills,
    currencies,
  });
  const byKey = new Map(plan.map((p): [string, unknown] => [p.key, p.payload]));
  expect(byKey.get('categories:2026-01-01:2026-03-31:CNY')).toEqual({
    insightCategories: [],
    total: { id: 'total' },
    perDay: undefined,
  });
  expect(byKey.get('budgets:2026-01-01:2026-03-31:CNY')).toEqual(budgets.budgets);
  expect(byKey.get('accounts:2026-01-01:2026-03-31:CNY:asset')).toEqual(accounts.accounts);
  expect(byKey.get('piggy_banks')).toEqual(piggyBanks.piggyBanks);
  expect(byKey.get('bills')).toEqual(bills.bills);
  expect(byKey.get('currencies')).toEqual(currencies);
});

test('非对象输入返回空计划且不抛错', () => {
  expect(planLegacyMigration(undefined)).toEqual([]);
  expect(planLegacyMigration('persist:root')).toEqual([]);
  expect(planLegacyMigration(42)).toEqual([]);
  expect(planLegacyMigration([])).toEqual([]);
});

test('模型值是字符串（未二次解析）时跳过对应键', () => {
  const plan = planLegacyMigration({
    firefly: '{"rangeDetails":{"start":"2026-01-01","end":"2026-03-31"}}',
    piggyBanks: '{"piggyBanks":[]}',
    currencies: { currentCode: 'CNY' },
  });
  // firefly/piggyBanks 仍是字符串 → 视为缺字段；只剩不依赖区间的 currencies。
  expect(plan.map((p) => p.key)).toEqual(['currencies']);
});

describe('parseLegacyRoot', () => {
  test('两层解析：外层 JSON 的值是 JSON 字符串', () => {
    const result = parseLegacyRoot(JSON.stringify({
      firefly: JSON.stringify({ rangeDetails: { start: '2026-01-01' } }),
    }));
    expect(result).not.toBeNull();
    expect(result?.hadParseFailure).toBe(false);
    expect(result?.models).toEqual({ firefly: { rangeDetails: { start: '2026-01-01' } } });
  });

  test('个别模型损坏：hadParseFailure=true 且有效模型仍返回', () => {
    const result = parseLegacyRoot(JSON.stringify({
      firefly: JSON.stringify({ rangeDetails: { start: '2026-01-01' } }),
      categories: '{broken json',
      piggyBanks: JSON.stringify({ piggyBanks: [] }),
    }));
    expect(result).not.toBeNull();
    expect(result?.hadParseFailure).toBe(true);
    expect(result?.models).toEqual({
      firefly: { rangeDetails: { start: '2026-01-01' } },
      piggyBanks: { piggyBanks: [] },
    });
  });

  test('外层 JSON 损坏返回 null', () => {
    expect(parseLegacyRoot('{broken outer')).toBeNull();
  });

  test('外层解析为非对象返回 null', () => {
    expect(parseLegacyRoot('123')).toBeNull();
    expect(parseLegacyRoot('"a string"')).toBeNull();
  });
});

describe('legacyMigrationAllowed', () => {
  test('旧数据未记录 backendURL 时保持原行为（允许迁移）', () => {
    expect(legacyMigrationAllowed({}, 'https://home.example')).toBe(true);
    expect(legacyMigrationAllowed({ configuration: {} }, 'https://home.example')).toBe(true);
    expect(legacyMigrationAllowed({ configuration: { backendURL: '' } }, 'https://home.example')).toBe(true);
  });

  test('归一化后比较：大小写与尾斜杠不影响归属', () => {
    const models = { configuration: { backendURL: 'HTTPS://Home.Example/' } };
    expect(legacyMigrationAllowed(models, 'https://home.example')).toBe(true);
    expect(legacyMigrationAllowed(models, 'https://home.example///')).toBe(true);
  });

  test('后端地址不一致时不允许迁移', () => {
    const models = { configuration: { backendURL: 'https://other.example' } };
    expect(legacyMigrationAllowed(models, 'https://home.example')).toBe(false);
  });

  test('当前后端地址未知（拿不到凭据）时无法证明归属，跳过迁移', () => {
    const models = { configuration: { backendURL: 'https://home.example' } };
    expect(legacyMigrationAllowed(models, '')).toBe(false);
  });
});

// 迁移运行器：假 Db 只记录写入参数，配合被 mock 的 AsyncStorage 验证「不写、不删」。
const storageMock = AsyncStorage as unknown as {
  getItem: jest.Mock;
  removeItem: jest.Mock;
};

const legacyRoot = (models: Record<string, unknown>): string => JSON.stringify(
  Object.keys(models).reduce<Record<string, string>>((acc, key) => {
    acc[key] = JSON.stringify(models[key]);
    return acc;
  }, {}),
);

const createFakeDb = (): { db: Db; runs: unknown[][] } => {
  const runs: unknown[][] = [];
  return {
    runs,
    db: {
      exec: async () => {},
      run: async (_sql: string, params: unknown[] = []) => {
        runs.push(params);
      },
      all: async <T>(): Promise<T[]> => [],
      get: async <T>(): Promise<T | null> => null,
      tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    },
  };
};

describe('migrateLegacyState 的账号核对', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storageMock.getItem.mockResolvedValue(null);
    storageMock.removeItem.mockResolvedValue(undefined);
  });

  test('旧数据属于另一个后端账号时跳过：不写 blob、不删旧键、不标失败', async () => {
    storageMock.getItem.mockResolvedValue(legacyRoot({
      configuration: { backendURL: 'https://alpha.example' },
      piggyBanks: { piggyBanks: [] },
    }));
    const { db, runs } = createFakeDb();

    await migrateLegacyState(db, 'scopeB', 'https://beta.example');

    expect(runs).toEqual([]);
    expect(storageMock.removeItem).not.toHaveBeenCalled();
  });

  test('旧数据与当前账号一致时照常迁移并删除旧键', async () => {
    storageMock.getItem.mockResolvedValue(legacyRoot({
      configuration: { backendURL: 'HTTPS://Alpha.Example/' },
      piggyBanks: { piggyBanks: [{ id: '2' }] },
    }));
    const { db, runs } = createFakeDb();

    await migrateLegacyState(db, 'scopeA', 'https://alpha.example');

    // 一条 blob 写入：piggy_banks；写的是当前 scope。
    expect(runs).toHaveLength(1);
    expect(runs[0][0]).toBe('scopeA');
    expect(runs[0][1]).toBe('piggy_banks');
    expect(storageMock.removeItem).toHaveBeenCalledWith('persist:root');
  });

  test('旧数据未记录 backendURL 时按原行为迁移（单一账号升级路径）', async () => {
    storageMock.getItem.mockResolvedValue(legacyRoot({ bills: { bills: [] } }));
    const { db, runs } = createFakeDb();

    await migrateLegacyState(db, 'scopeA', 'https://alpha.example');

    expect(runs).toHaveLength(1);
    expect(storageMock.removeItem).toHaveBeenCalledWith('persist:root');
  });
});
