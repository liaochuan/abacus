import {
  cachedCurrencies,
  cachedCurrentCode,
  readCachedCurrencies,
  readCachedCurrentCode,
} from '../cachedCurrencies';
import { getDb } from '../instance';
import { getCurrentScope } from '../scope';
import type { Db } from '../types';

jest.mock('../instance', () => ({ __esModule: true, getDb: jest.fn() }));
jest.mock('../scope', () => ({ __esModule: true, getCurrentScope: jest.fn() }));

const getDbMock = getDb as jest.MockedFunction<typeof getDb>;
const getCurrentScopeMock = getCurrentScope as jest.MockedFunction<typeof getCurrentScope>;

// 假 Db 走 readBlob 的真实 SQL 语义（WHERE scope_id = ? AND key = ?），
// 只返回该 scope 的 currencies 行；其余查询视为测试错误。
type BlobRow = { scopeId: string; key: string; payload: string };

const createBlobDb = (rows: BlobRow[]): Db => ({
  exec: async () => {},
  run: async () => {},
  all: async <T>(): Promise<T[]> => [],
  get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
    if (!/FROM blobs/i.test(sql)) {
      throw new Error(`unexpected sql: ${sql}`);
    }
    const row = rows.find((item) => item.scopeId === params[0] && item.key === params[1]);
    if (!row) {
      return null;
    }
    return { payload: row.payload, fetchedAt: '2026-10-01T00:00:00Z' } as unknown as T;
  },
  tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
});

const currenciesRow = (scopeId: string, payload: unknown): BlobRow => ({
  scopeId,
  key: 'currencies',
  payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
});

test('离线时从 currencies blob 读回当前币种', async () => {
  const db = createBlobDb([currenciesRow('scope1', { currentCode: 'CNY', currencies: [{ id: '1' }] })]);

  await expect(readCachedCurrentCode(db, 'scope1')).resolves.toBe('CNY');
});

test('只读当前 scope 的币种缓存', async () => {
  const db = createBlobDb([currenciesRow('scope2', { currentCode: 'EUR' })]);

  await expect(readCachedCurrentCode(db, 'scope1')).resolves.toBeNull();
});

test('缓存缺失、currentCode 为空或形状不对时返回 null', async () => {
  await expect(readCachedCurrentCode(createBlobDb([]), 'scope1')).resolves.toBeNull();
  await expect(readCachedCurrentCode(
    createBlobDb([currenciesRow('scope1', { currentCode: '' })]),
    'scope1',
  )).resolves.toBeNull();
  await expect(readCachedCurrentCode(
    createBlobDb([currenciesRow('scope1', { currencies: [] })]),
    'scope1',
  )).resolves.toBeNull();
  await expect(readCachedCurrentCode(
    createBlobDb([currenciesRow('scope1', ['CNY'])]),
    'scope1',
  )).resolves.toBeNull();
});

test('缓存损坏（非法 JSON）时返回 null 而不抛错', async () => {
  await expect(readCachedCurrentCode(
    createBlobDb([currenciesRow('scope1', '{not json')]),
    'scope1',
  )).resolves.toBeNull();
});

test('离线时从 currencies blob 读回完整币种列表', async () => {
  const currencies = [
    {
      id: '1', type: 'currencies', attributes: { code: 'CNY', symbol: '¥', name: 'Chinese Yuan' },
    },
    {
      id: '2', type: 'currencies', attributes: { code: 'EUR', symbol: '€', name: 'Euro' },
    },
  ];
  const db = createBlobDb([currenciesRow('scope1', { currentCode: 'CNY', currencies })]);

  await expect(readCachedCurrencies(db, 'scope1')).resolves.toEqual({ currentCode: 'CNY', currencies });
});

test('币种列表里没有 code 的条目被丢弃，id 归一化为字符串并补显示字段', async () => {
  const db = createBlobDb([
    currenciesRow('scope1', {
      currentCode: 'CNY',
      currencies: [
        { id: '1', attributes: { code: 'CNY' } },
        { id: 9, attributes: { code: 'USD', name: 'US Dollar', symbol: '$' } },
        { id: '2', attributes: {} },
        { id: '3' },
        'EUR',
        null,
      ],
    }),
  ]);

  await expect(readCachedCurrencies(db, 'scope1')).resolves.toEqual({
    currentCode: 'CNY',
    currencies: [
      {
        id: '1',
        type: 'currencies',
        attributes: {
          code: 'CNY', symbol: '', name: 'CNY',
        },
      },
      {
        id: '9',
        type: 'currencies',
        attributes: {
          code: 'USD', name: 'US Dollar', symbol: '$',
        },
      },
    ],
  });
});

test('只有 currentCode 的旧缓存返回空列表', async () => {
  const db = createBlobDb([currenciesRow('scope1', { currentCode: 'CNY' })]);

  await expect(readCachedCurrencies(db, 'scope1')).resolves.toEqual({
    currentCode: 'CNY',
    currencies: [],
  });
});

test('币种缓存缺失、形状不对或既无代码又无列表时返回 null', async () => {
  await expect(readCachedCurrencies(createBlobDb([]), 'scope1')).resolves.toBeNull();
  await expect(readCachedCurrencies(
    createBlobDb([currenciesRow('scope1', ['CNY'])]),
    'scope1',
  )).resolves.toBeNull();
  await expect(readCachedCurrencies(
    createBlobDb([currenciesRow('scope1', { currentCode: '', currencies: [{ id: '1' }] })]),
    'scope1',
  )).resolves.toBeNull();
});

test('币种列表缓存损坏（非法 JSON）时返回 null 而不抛错', async () => {
  await expect(readCachedCurrencies(
    createBlobDb([currenciesRow('scope1', '{not json')]),
    'scope1',
  )).resolves.toBeNull();
});

test('readCachedCurrencies 只读取当前 scope 的币种缓存', async () => {
  const db = createBlobDb([
    currenciesRow('scope2', {
      currentCode: 'EUR',
      currencies: [{ id: '2', attributes: { code: 'EUR' } }],
    }),
  ]);

  await expect(readCachedCurrencies(db, 'scope1')).resolves.toBeNull();
  await expect(readCachedCurrencies(db, 'scope2')).resolves.toEqual({
    currentCode: 'EUR',
    currencies: [{
      id: '2',
      type: 'currencies',
      attributes: { code: 'EUR', symbol: '', name: 'EUR' },
    }],
  });
});

describe('cachedCurrentCode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('读当前 scope 的缓存币种', async () => {
    getDbMock.mockReturnValue(createBlobDb([currenciesRow('scope1', { currentCode: 'CNY' })]));
    getCurrentScopeMock.mockResolvedValue('scope1');

    await expect(cachedCurrentCode()).resolves.toBe('CNY');
  });

  test('尚未选定 scope 时不读库', async () => {
    getDbMock.mockReturnValue(createBlobDb([currenciesRow('scope1', { currentCode: 'CNY' })]));
    getCurrentScopeMock.mockResolvedValue('');

    await expect(cachedCurrentCode()).resolves.toBeNull();
  });

  test('DB 未初始化时返回 null 而不抛错', async () => {
    getDbMock.mockImplementation(() => {
      throw new Error('db not ready');
    });
    getCurrentScopeMock.mockResolvedValue('scope1');

    await expect(cachedCurrentCode()).resolves.toBeNull();
  });
});

describe('cachedCurrencies', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('读当前 scope 的完整币种缓存', async () => {
    getDbMock.mockReturnValue(createBlobDb([
      currenciesRow('scope1', {
        currentCode: 'EUR',
        currencies: [{
          id: '2', type: 'currencies', attributes: { code: 'EUR', symbol: '€', name: 'Euro' },
        }],
      }),
    ]));
    getCurrentScopeMock.mockResolvedValue('scope1');

    await expect(cachedCurrencies()).resolves.toEqual({
      currentCode: 'EUR',
      currencies: [{
        id: '2', type: 'currencies', attributes: { code: 'EUR', symbol: '€', name: 'Euro' },
      }],
    });
  });

  test('尚未选定 scope 时不读库', async () => {
    getDbMock.mockReturnValue(createBlobDb([currenciesRow('scope1', { currentCode: 'CNY' })]));
    getCurrentScopeMock.mockResolvedValue('');

    await expect(cachedCurrencies()).resolves.toBeNull();
  });

  test('DB 未初始化时返回 null 而不抛错', async () => {
    getDbMock.mockImplementation(() => {
      throw new Error('db not ready');
    });
    getCurrentScopeMock.mockResolvedValue('scope1');

    await expect(cachedCurrencies()).resolves.toBeNull();
  });
});
