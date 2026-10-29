import { computePullWindow, pickDuplicate, pickDuplicateGroup } from '../syncWindows';
import type { TransactionSplitType, TransactionType } from '../../models/transactions';

// 所有时间点都由本地日历分量构造，再序列化为 ISO 串。
// 这样无论运行时区是 UTC-11 还是 UTC+14，解析回来都落在同一个本地日历日，
// 测试不依赖固定时区偏移。
const localDate = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour, 0, 0);
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute, 0).toISOString();

const PAYLOAD_DATE = at(1, 8);

function splitOf(overrides: Partial<TransactionSplitType> = {}): TransactionSplitType {
  return {
    description: 'coffee',
    amount: '3.50',
    date: PAYLOAD_DATE,
    sourceName: 'Cash',
    destinationName: 'Shop',
    ...overrides,
  } as TransactionSplitType;
}

function transactionOf(id: string, splits: Partial<TransactionSplitType>[] = [{}]): TransactionType {
  return {
    id,
    type: 'transactions',
    attributes: {
      groupTitle: '',
      transactions: splits.map(splitOf),
    },
  } as unknown as TransactionType;
}

describe('computePullWindow', () => {
  test('增量窗口回退 90 天，全量窗口回退 365 天', () => {
    const now = localDate(2026, 10, 27);
    expect(computePullWindow(now, false)).toEqual({ start: '2026-07-29', end: '2026-10-27' });
    expect(computePullWindow(now, true)).toEqual({ start: '2025-10-27', end: '2026-10-27' });
  });

  test('跨年与补零', () => {
    expect(computePullWindow(localDate(2026, 1, 15), false)).toEqual({ start: '2025-10-17', end: '2026-01-15' });
    expect(computePullWindow(localDate(2026, 1, 5, 23), true)).toEqual({ start: '2025-01-05', end: '2026-01-05' });
  });

  test('闰年按自然日回退（2028-03-01 的 365 天前是 2027-03-02）', () => {
    expect(computePullWindow(localDate(2028, 3, 1), true)).toEqual({ start: '2027-03-02', end: '2028-03-01' });
    expect(computePullWindow(localDate(2028, 3, 1), false)).toEqual({ start: '2027-12-02', end: '2028-03-01' });
  });

  test('使用 now 的本地日历日，且不修改入参', () => {
    const now = localDate(2026, 10, 27, 23);
    const before = now.getTime();
    expect(computePullWindow(now, true).end).toBe('2026-10-27');
    expect(now.getTime()).toBe(before);
  });
});

describe('pickDuplicateGroup', () => {
  const groupOf = (
    id: string,
    splits: Partial<TransactionSplitType>[],
    createdAt?: string,
  ): TransactionType => ({
    id,
    type: 'transactions',
    attributes: {
      groupTitle: '',
      transactions: splits.map(splitOf),
      ...(createdAt === undefined ? {} : { createdAt }),
    },
  } as unknown as TransactionType);

  const payload = groupOf('new', [{}]);

  test('整组一致且唯一时返回候选', () => {
    expect(pickDuplicateGroup([groupOf('9', [{}])], payload)?.id).toBe('9');
    expect(pickDuplicateGroup([groupOf('9', [{}, { description: 'tea', amount: '1' }])],
      groupOf('new', [{}, { description: 'tea', amount: '1' }]))?.id).toBe('9');
  });

  test('split 数量或任意一笔不同都不匹配', () => {
    expect(pickDuplicateGroup([groupOf('9', [{}, {}])], payload)).toBeNull();
    expect(pickDuplicateGroup([groupOf('9', [{}, { description: 'tea', amount: '1' }])], payload)).toBeNull();
    expect(pickDuplicateGroup([groupOf('9', [{}, {}])],
      groupOf('new', [{}, { description: 'tea' }]))).toBeNull();
  });

  test('候选组 createdAt 早于入队时间则排除', () => {
    const notBefore = '2026-10-01T00:00:00.000Z';
    expect(pickDuplicateGroup([groupOf('9', [{}], '2026-09-30T23:59:59.000Z')], payload, notBefore)).toBeNull();
    expect(pickDuplicateGroup([groupOf('9', [{}], '2026-10-01T00:00:00.000Z')], payload, notBefore)?.id).toBe('9');
    // 缺失或无法解析时不按时间过滤
    expect(pickDuplicateGroup([groupOf('9', [{}])], payload, notBefore)?.id).toBe('9');
    expect(pickDuplicateGroup([groupOf('9', [{}], 'not-a-date')], payload, notBefore)?.id).toBe('9');
  });

  test('多候选仍返回 null，空 payload 不参与匹配', () => {
    expect(pickDuplicateGroup([groupOf('9', [{}]), groupOf('10', [{}])], payload)).toBeNull();
    expect(pickDuplicateGroup([groupOf('9', [{}])], groupOf('new', []))).toBeNull();
  });
});

describe('pickDuplicate', () => {
  const payload = transactionOf('new');

  test('唯一匹配时返回该候选', () => {
    expect(pickDuplicate([transactionOf('9')], payload)?.id).toBe('9');
    // 不匹配的候选不影响唯一性
    expect(pickDuplicate([transactionOf('9'), transactionOf('10', [{ description: 'tea' }])], payload)?.id).toBe('9');
  });

  test('零匹配或多匹配返回 null', () => {
    expect(pickDuplicate([], payload)).toBeNull();
    expect(pickDuplicate([transactionOf('9', [{ description: 'tea' }])], payload)).toBeNull();
    expect(pickDuplicate([transactionOf('9'), transactionOf('10')], payload)).toBeNull();
  });

  test('金额按数值比较，NaN 永不匹配', () => {
    expect(pickDuplicate([transactionOf('9', [{ amount: '3.5' }])], payload)?.id).toBe('9');
    expect(pickDuplicate([transactionOf('9', [{ amount: '3.51' }])], payload)).toBeNull();
    expect(pickDuplicate([transactionOf('9', [{ amount: 'abc' }])], payload)).toBeNull();
    expect(
      pickDuplicate([transactionOf('9', [{ amount: 'abc' }])], transactionOf('new', [{ amount: 'abc' }])),
    ).toBeNull();
  });

  test('逗号小数按数值比较，空金额不互相匹配', () => {
    expect(pickDuplicate([transactionOf('9', [{ amount: '3,50' }])], payload)?.id).toBe('9');
    expect(
      pickDuplicate([transactionOf('9', [{ amount: '3,5' }])], transactionOf('new', [{ amount: '3.50' }]))?.id,
    ).toBe('9');
    expect(pickDuplicate([transactionOf('9', [{ amount: '3,51' }])], payload)).toBeNull();
    expect(
      pickDuplicate([transactionOf('9', [{ amount: '' }])], transactionOf('new', [{ amount: '' }])),
    ).toBeNull();
    expect(
      pickDuplicate([transactionOf('9', [{ amount: ' ' }])], transactionOf('new', [{ amount: ' ' }])),
    ).toBeNull();
  });

  test('日期按本地日历日比较', () => {
    // 同一天的凌晨与深夜都算同一天
    expect(pickDuplicate([transactionOf('9', [{ date: at(1, 0) }])], payload)?.id).toBe('9');
    expect(pickDuplicate([transactionOf('9', [{ date: at(1, 23, 30) }])], payload)?.id).toBe('9');
    // 相邻两天不算同一天
    expect(pickDuplicate([transactionOf('9', [{ date: at(2, 0, 30) }])], payload)).toBeNull();
    expect(pickDuplicate([transactionOf('9', [{ date: at(3, 8) }])], payload)).toBeNull();
    // Date 对象与字符串等价
    expect(pickDuplicate([transactionOf('9', [{ date: localDate(2026, 10, 1, 0) }])], payload)?.id).toBe('9');
    expect(pickDuplicate([transactionOf('9', [{ date: localDate(2026, 10, 2) }])], payload)).toBeNull();
    expect(pickDuplicate([transactionOf('9', [{ date: 'not-a-date' }])], payload)).toBeNull();
    // 纯日期字符串按本地日历日解释
    expect(pickDuplicate([transactionOf('9', [{ date: '2026-10-01' }])], payload)?.id).toBe('9');
  });

  test('描述、来源、去向都必须一致', () => {
    expect(pickDuplicate([transactionOf('9', [{ description: 'tea' }])], payload)).toBeNull();
    expect(pickDuplicate([transactionOf('9', [{ sourceName: 'Bank' }])], payload)).toBeNull();
    expect(pickDuplicate([transactionOf('9', [{ destinationName: 'Cafe' }])], payload)).toBeNull();
  });

  test('只比较首笔 split', () => {
    // 第二笔不同不影响匹配
    expect(
      pickDuplicate([transactionOf('9', [{}, { description: 'tea', amount: '99' }])], payload)?.id,
    ).toBe('9');
    // 首笔不同、第二笔相同则不算重复
    expect(
      pickDuplicate([transactionOf('9', [{ description: 'tea' }, {}])], payload),
    ).toBeNull();
  });

  test('缺少 split 的一侧不参与匹配', () => {
    expect(pickDuplicate([transactionOf('9', [])], payload)).toBeNull();
    expect(pickDuplicate([transactionOf('9')], transactionOf('new', []))).toBeNull();
  });
});
