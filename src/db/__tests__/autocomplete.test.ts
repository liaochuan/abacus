import {
  filterAutocomplete,
  filterAutocompleteByTypes,
  readAutocomplete,
} from '../autocomplete';
import type { AutocompleteOption } from '../autocomplete';
import type { Db } from '../types';

// 假 Db 按 blobs 表的真实查询语义（WHERE scope_id = ? AND key = ?）返回行，
// 让 readAutocomplete 走 readBlob 的真实 SQL 路径，而不是断言「调用了某个 mock」。
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

const blobRow = (scopeId: string, key: string, payload: unknown): BlobRow => ({
  scopeId,
  key,
  payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
});

// 只关心顺序与名称时，把选项投影成名称，避免每条断言重复写 id。
const namesOf = (options: AutocompleteOption[]): string[] => options.map((option) => option.name);

const option = (name: string, id = '', type?: string): AutocompleteOption => ({ id, name, type });

test('本地过滤大小写不敏感并限制条数', () => {
  const items = [
    option('Cash', '1'),
    option('Bank', '2'),
    option('cash wallet', '3'),
    option('Credit', '4'),
  ];
  expect(namesOf(filterAutocomplete(items, 'ca', 10))).toEqual(['Cash', 'cash wallet']);
  expect(namesOf(filterAutocomplete(items, '', 2))).toEqual(['Cash', 'Bank']);
  expect(filterAutocomplete(items, 'zzz', 10)).toEqual([]);
});

test('过滤保留原有选项（含 id 与 type），而不是只返回名称', () => {
  const items = [option('Cash', 'acc-1', 'Asset account')];
  expect(filterAutocomplete(items, 'ca', 10)).toEqual([option('Cash', 'acc-1', 'Asset account')]);
});

test('空查询保留输入顺序，并默认限制 20 条', () => {
  const items = Array.from({ length: 25 }, (_, index) => option(`Account ${index + 1}`, `${index + 1}`));
  const result = filterAutocomplete(items, '');
  expect(result).toHaveLength(20);
  expect(result).toEqual(items.slice(0, 20));
});

test('过滤结果保持原始顺序而不是匹配度排序', () => {
  const items = [option('credit card'), option('Cash'), option('savings cash')];
  expect(namesOf(filterAutocomplete(items, 'CASH', 10))).toEqual(['Cash', 'savings cash']);
});

test('limit 非正数时返回空数组', () => {
  expect(filterAutocomplete([option('Cash')], 'ca', 0)).toEqual([]);
});

test('查询前后空白被忽略', () => {
  expect(namesOf(filterAutocomplete([option('Cash'), option('Bank')], '  ca  ', 10))).toEqual(['Cash']);
});

test('账户类型过滤沿用线上 types 规则，缺 type 的旧候选保留', () => {
  const items = [
    option('Asset A', '1', 'Asset account'),
    option('Expense E', '2', 'Expense account'),
    option('Loan L', '3', 'Loan'),
    option('Legacy', ''),
  ];

  const filtered = filterAutocompleteByTypes(items, ['Asset account', 'Loan', 'Debt', 'Mortgage']);
  expect(namesOf(filtered)).toEqual(['Asset A', 'Loan L', 'Legacy']);
});

test('allowlist 为空时不做类型过滤', () => {
  const items = [option('Expense E', '2', 'Expense account')];
  expect(filterAutocompleteByTypes(items, [])).toEqual(items);
});

test('readAutocomplete 按 kind 读取 autocomplete:<kind> 并保持缓存顺序', async () => {
  const db = createBlobDb([blobRow('scope1', 'autocomplete:accounts', ['Cash', 'Bank', 'Credit'])]);

  await expect(readAutocomplete(db, 'scope1', 'accounts')).resolves.toEqual([
    option('Cash'),
    option('Bank'),
    option('Credit'),
  ]);
  await expect(readAutocomplete(db, 'scope1', 'categories')).resolves.toEqual([]);
});

test('readAutocomplete 只读取当前 scope 的缓存', async () => {
  const db = createBlobDb([blobRow('scope2', 'autocomplete:accounts', ['Other scope account'])]);

  await expect(readAutocomplete(db, 'scope1', 'accounts')).resolves.toEqual([]);
  await expect(readAutocomplete(db, 'scope2', 'accounts')).resolves.toEqual([option('Other scope account')]);
});

test('readAutocomplete 缓存缺失时返回空数组', async () => {
  await expect(readAutocomplete(createBlobDb([]), 'scope1', 'bills')).resolves.toEqual([]);
});

test('readAutocomplete 缓存损坏（非法 JSON）时返回空数组而不抛错', async () => {
  const db = createBlobDb([blobRow('scope1', 'autocomplete:tags', '{not json')]);

  await expect(readAutocomplete(db, 'scope1', 'tags')).resolves.toEqual([]);
});

test('readAutocomplete 缓存形状不对（非数组）时返回空数组', async () => {
  const db = createBlobDb([blobRow('scope1', 'autocomplete:budgets', { items: ['Groceries'] })]);

  await expect(readAutocomplete(db, 'scope1', 'budgets')).resolves.toEqual([]);
});

test('readAutocomplete 保留同步缓存里的 id 与 type', async () => {
  const db = createBlobDb([
    blobRow('scope1', 'autocomplete:accounts', [
      { id: '1', name: 'Cash', type: 'Asset account' },
      { id: '2', name: 'Bank' },
    ]),
  ]);

  await expect(readAutocomplete(db, 'scope1', 'accounts')).resolves.toEqual([
    option('Cash', '1', 'Asset account'),
    option('Bank', '2'),
  ]);
});

test('readAutocomplete 兼容旧缓存 { name }[]，缺失 id 补空串', async () => {
  const db = createBlobDb([
    blobRow('scope1', 'autocomplete:categories', [{ name: 'Groceries' }, { id: '7', name: 'Travel' }]),
  ]);

  await expect(readAutocomplete(db, 'scope1', 'categories')).resolves.toEqual([
    option('Groceries'),
    option('Travel', '7'),
  ]);
});

test('readAutocomplete 丢弃无法解析成名称的条目', async () => {
  const db = createBlobDb([
    blobRow('scope1', 'autocomplete:tags', ['Food', 42, null, { id: '3' }, { name: 'Travel' }, '']),
  ]);

  await expect(readAutocomplete(db, 'scope1', 'tags')).resolves.toEqual([
    option('Food'),
    option('Travel'),
  ]);
});

test('读出的选项可直接交给本地过滤器并保留 id', async () => {
  const db = createBlobDb([
    blobRow('scope1', 'autocomplete:accounts', [
      { id: '1', name: 'Cash' },
      { id: '2', name: 'Bank' },
      { id: '3', name: 'cash wallet' },
    ]),
  ]);

  const items = await readAutocomplete(db, 'scope1', 'accounts');
  expect(filterAutocomplete(items, 'ca', 10)).toEqual([option('Cash', '1'), option('cash wallet', '3')]);
});
