import { diffTransaction } from '../notices';

// 冲突 diff 是纯函数：只比对两个 payload，不碰数据库、不读 i18n。
// 断言只覆盖「哪些字段不同、属于第几个 split、两侧原值是什么」，
// 具体文案与列布局由 SyncNoticeModal 负责。

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

const payload = (groupTitle: string, splits: unknown[]) => ({
  attributes: { groupTitle, transactions: splits },
} as any);

test('逐 split 输出差异字段', () => {
  const local = payload('L', [split(), split({ description: 'b', amount: '2' })]);
  const server = payload('S', [split({ amount: '9' })]);
  const diff = diffTransaction(local, server);
  expect(diff).toContainEqual({
    field: 'group_title', split: -1, local: 'L', server: 'S',
  });
  expect(diff).toContainEqual({
    field: 'amount', split: 0, local: '1', server: '9',
  });
  // 本地多出的 split：索引 1 上必须有一条记录。
  expect(diff.some((d) => d.split === 1)).toBe(true);
  expect(diff).toContainEqual({
    field: 'split_missing_on_server', split: 1, local: 'b · 2', server: '',
  });
});

test('完全一致的交易不产生差异（金额按数值、标签按集合比较）', () => {
  const local = payload('Same', [
    split({ amount: '1', tags: ['a', 'b'] }),
  ]);
  const server = payload('Same', [
    split({ amount: '1.00', tags: ['b', 'a'] }),
  ]);
  expect(diffTransaction(local, server)).toEqual([]);
});

test('服务端多出的 split 标记为 split_missing_locally', () => {
  const local = payload('T', [split()]);
  const server = payload('T', [split(), split({ description: 'extra', amount: '3' })]);
  expect(diffTransaction(local, server)).toContainEqual({
    field: 'split_missing_locally', split: 1, local: '', server: 'extra · 3',
  });
});

test('逐字段比较账号、标签、备注与日期（日期只比到天）', () => {
  const local = payload('T', [split({
    tags: ['home'],
    notes: '旧备注',
    sourceName: 'Cash',
    destinationName: 'Shop',
    date: '2026-10-01T08:00:00.000Z',
  })]);
  const server = payload('T', [split({
    tags: ['work'],
    notes: '新备注',
    sourceName: 'Bank',
    destinationName: 'Market',
    date: new Date(2026, 9, 2),
  })]);
  const fields = diffTransaction(local, server).map((d) => d.field);

  expect(fields).toEqual(expect.arrayContaining([
    'tags', 'notes', 'sourceName', 'destinationName', 'date',
  ]));
  expect(fields).not.toContain('categoryName');
  expect(fields).not.toContain('amount');
  expect(diffTransaction(local, server)).toContainEqual({
    field: 'tags', split: 0, local: 'home', server: 'work',
  });
});

test('payload 缺 attributes / transactions 时退化为空，不抛错', () => {
  expect(diffTransaction({} as any, { attributes: {} } as any)).toEqual([]);
  expect(diffTransaction(payload('', []), payload('', []))).toEqual([]);
});
