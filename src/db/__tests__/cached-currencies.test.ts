import { cachedCurrentCode, readCachedCurrentCode } from '../cachedCurrencies';
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
