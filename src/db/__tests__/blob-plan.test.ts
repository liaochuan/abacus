import {
  buildAccountsBlob,
  buildBalanceChartUrl,
  buildBillsBlob,
  buildBudgetsBlob,
  buildCategoriesBlob,
  buildChartAccountsBlob,
  extractSummary,
  planBlobRefresh,
  pullBlobs,
} from '../syncBlobs';
import type { BlobSyncContext } from '../syncBlobs';
import type { Db } from '../types';

// 全部用 fake http / fake Db：本文件不发网络请求，也不依赖真实 SQLite。
// fake Db 校验占位符数量、scope_id 过滤与首参绑定，防止实现漂移。

const BASE_CTX: BlobSyncContext = {
  backendURL: 'https://ff',
  accessToken: 't',
  http: {} as never,
  range: { start: '2026-07-01', end: '2026-09-30' },
  currencyCode: 'CNY',
  displayAllAccounts: true,
  apiVersion: '6.3.0',
  refreshToken: async () => 't',
};

const ctxWith = (overrides: Partial<BlobSyncContext> = {}): BlobSyncContext => ({
  ...BASE_CTX,
  ...overrides,
});

const keysOf = (ctx: BlobSyncContext, options?: Parameters<typeof planBlobRefresh>[1]): string[] => (
  planBlobRefresh(ctx, options).map((item) => item.key)
);

// ---------------------------------------------------------------------------
// planBlobRefresh：键覆盖与低频门控

test('刷新计划覆盖当前区间与全部维度', () => {
  const plan = planBlobRefresh(ctxWith(), {
    staleLowFrequency: new Set(['bills', 'piggy_banks', 'currencies']),
  });
  const keys = plan.map((p) => p.key);
  expect(keys).toContain('accounts:2026-07-01:2026-09-30:CNY:all');
  expect(keys).toContain('categories:2026-07-01:2026-09-30:CNY');
  expect(keys).toContain('budgets:2026-07-01:2026-09-30:CNY');
  expect(keys).toContain('summary:2026-07-01:2026-09-30:CNY');
  expect(keys).toContain('chart:accounts:2026-07-01:2026-09-30:CNY:all');
  expect(keys).toContain('chart:balance:2026-07-01:2026-09-30:CNY');
  expect(keys).toContain('autocomplete:accounts');
  expect(keys).toContain('autocomplete:categories');
  expect(keys).toContain('autocomplete:budgets');
  expect(keys).toContain('autocomplete:bills');
  expect(keys).toContain('autocomplete:tags');
  expect(keys).toContain('bills');
  expect(keys).toContain('piggy_banks');
  expect(keys).toContain('currencies');
  expect(keys).toHaveLength(14);
});

test('displayAllAccounts=false 时 accounts/chart 键为该区间+币种的 asset 变体', () => {
  const keys = keysOf(ctxWith({ displayAllAccounts: false }));
  expect(keys).toContain('accounts:2026-07-01:2026-09-30:CNY:asset');
  expect(keys).toContain('chart:accounts:2026-07-01:2026-09-30:CNY:asset');
  expect(keys).not.toContain('accounts:2026-07-01:2026-09-30:CNY:all');
});

test('低频键只在缺失或超过 1 小时时纳入计划', () => {
  // 不传选项 = 空集合：低频键默认不刷新（避免调用方漏传时每轮都请求）。
  const defaults = keysOf(ctxWith());
  expect(defaults).not.toContain('bills');
  expect(defaults).not.toContain('piggy_banks');
  expect(defaults).not.toContain('currencies');
  expect(defaults).toHaveLength(11);

  // 传入集合 = 只刷新集合里的低频键；空集合同样表示都还新鲜。
  const fresh = keysOf(ctxWith(), { staleLowFrequency: new Set<string>() });
  expect(fresh).not.toContain('bills');
  expect(fresh).not.toContain('piggy_banks');
  expect(fresh).not.toContain('currencies');

  const all = keysOf(ctxWith(), {
    staleLowFrequency: new Set(['bills', 'piggy_banks', 'currencies']),
  });
  expect(all).toEqual(expect.arrayContaining(['bills', 'piggy_banks', 'currencies']));
  expect(all).toHaveLength(14);

  const billsOnly = keysOf(ctxWith(), { staleLowFrequency: new Set(['bills']) });
  expect(billsOnly).toContain('bills');
  expect(billsOnly).not.toContain('piggy_banks');
  expect(billsOnly).not.toContain('currencies');
});

test('计划中的 URL 指向对应 Firefly 端点，chart balance 按版本分支', () => {
  const allLowFrequency = new Set(['bills', 'piggy_banks', 'currencies']);
  const plan = planBlobRefresh(ctxWith({ apiVersion: '6.3.0' }), { staleLowFrequency: allLowFrequency });
  const urlOf = (kind: string) => plan.find((item) => item.kind === kind)?.url;

  expect(urlOf('accounts')).toBe(
    'https://ff/api/v1/currencies/CNY/accounts?start=2026-07-01&end=2026-09-30&date=2026-09-30',
  );
  expect(urlOf('categories')).toBe(
    'https://ff/api/v1/insight/expense/category?start=2026-07-01&end=2026-09-30',
  );
  expect(urlOf('budgets')).toBe('https://ff/api/v1/budgets?start=2026-07-01&end=2026-09-30');
  expect(urlOf('summary')).toBe(
    'https://ff/api/v1/summary/basic?start=2026-07-01&end=2026-09-30&currency_code=CNY',
  );
  expect(urlOf('chartAccounts')).toBe(
    'https://ff/api/v1/chart/account/overview?start=2026-07-01&end=2026-09-30&preselected=all',
  );
  expect(urlOf('chartBalance')).toBe(
    'https://ff/api/v1/chart/balance/balance?start=2026-07-01&end=2026-09-30',
  );
  expect(urlOf('autocomplete')).toBe('https://ff/api/v1/autocomplete/accounts?limit=100&query=');
  expect(urlOf('bills')).toBe('https://ff/api/v1/bills?start=2026-07-01&end=2026-09-30');
  expect(urlOf('piggyBanks')).toBe('https://ff/api/v1/piggy-banks');
  expect(urlOf('currencies')).toBe('https://ff/api/v1/currencies');

  const older = planBlobRefresh(ctxWith({ apiVersion: '6.2.0' }), { staleLowFrequency: allLowFrequency });
  expect(older.find((item) => item.kind === 'chartBalance')?.url).toBe(
    'https://ff/api/v2/chart/balance/balance?start=2026-07-01&end=2026-09-30',
  );
});

test('buildBalanceChartUrl 拼接账户过滤参数', () => {
  expect(buildBalanceChartUrl('https://ff', BASE_CTX.range, '6.3.0', ['1', '2'])).toBe(
    'https://ff/api/v1/chart/balance/balance?start=2026-07-01&end=2026-09-30&filter[accounts][]=1&filter[accounts][]=2',
  );
  expect(buildBalanceChartUrl('https://ff', BASE_CTX.range, '6.2.0', [])).toBe(
    'https://ff/api/v2/chart/balance/balance?start=2026-07-01&end=2026-09-30',
  );
});

// ---------------------------------------------------------------------------
// 聚合纯函数

const insight = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Food',
  currencyCode: 'CNY',
  currencyId: '1',
  differenceFloat: 0,
  ...overrides,
});

test('categories 合并支出/收入/无分类，按币种过滤并累加 total 与 perDay', () => {
  const blob = buildCategoriesBlob(
    [insight({ differenceFloat: -30 })],
    [insight({ id: 'none', name: 'none', differenceFloat: -5 })],
    [insight({ differenceFloat: 50 })],
    [insight({ id: 'none2', name: 'none2', differenceFloat: 7 })],
    'CNY',
    '2026-07-01',
    '2026-09-30',
    new Date('2026-10-27T00:00:00'),
  );

  const byId = new Map(blob.insightCategories.map((item) => [item.id, item]));
  expect(byId.get('c1')).toMatchObject({ income: 50, expense: -30, difference: 20 });
  // 两个 no-category 端点都归到 id 'no-cat'，与旧实现一样合并成一条：+7 与 -5 → 2。
  expect(byId.get('no-cat')).toMatchObject({
    name: 'no-category', income: 7, expense: -5, difference: 2,
  });
  expect(blob.insightCategories).toHaveLength(2);
  // 按 |difference| 降序：c1(20) 在 no-cat(2) 之前。
  expect(blob.insightCategories.map((item) => item.id)).toEqual(['c1', 'no-cat']);

  expect(blob.total).toMatchObject({
    id: 'total',
    name: 'total',
    income: 57,
    expense: -35,
    difference: 22,
    currencyCode: 'CNY',
    currencyId: '1',
  });
  // Jul 1 → Sep 30 共 92 天（含首尾）。
  expect(blob.perDay?.income).toBeCloseTo(57 / 92);
  expect(blob.perDay?.expense).toBeCloseTo(-35 / 92);
  expect(blob.perDay?.difference).toBeCloseTo(22 / 92);
});

test('categories 同 id 不同币种分开合并，不会先加总再按首行币种过滤', () => {
  const blob = buildCategoriesBlob(
    [
      insight({ differenceFloat: -30 }),
      insight({ currencyCode: 'EUR', currencyId: '2', differenceFloat: -70 }),
    ],
    [],
    [insight({ differenceFloat: 50 })],
    [],
    'CNY',
    '2026-07-01',
    '2026-09-30',
    new Date('2026-10-27T00:00:00'),
  );

  // 只按 id 合并会得到 income 50 / expense -100 / difference -50；按 id+币种合并后 CNY 行保持独立。
  expect(blob.insightCategories).toHaveLength(1);
  expect(blob.insightCategories[0]).toMatchObject({
    id: 'c1', currencyCode: 'CNY', income: 50, expense: -30, difference: 20,
  });
  expect(blob.total).toMatchObject({
    income: 50, expense: -30, difference: 20, currencyCode: 'CNY', currencyId: '1',
  });
});

test('categories 只保留当前币种；没有匹配时 total 归零且不产出 perDay', () => {
  const blob = buildCategoriesBlob(
    [insight({ currencyCode: 'EUR', differenceFloat: -30 })],
    [],
    [],
    [],
    'CNY',
    '2026-07-01',
    '2026-09-30',
    new Date('2026-10-27T00:00:00'),
  );
  expect(blob.insightCategories).toEqual([]);
  expect(blob.total).toMatchObject({
    income: 0, expense: 0, difference: 0, currencyCode: '',
  });
  expect(blob.perDay).toBeUndefined();
});

const budget = (overrides: Record<string, unknown> = {}) => ({
  id: 'b1',
  attributes: {
    name: 'Rent',
    active: true,
    order: 1,
    spent: [{ currencyCode: 'CNY', sum: '-80' }],
    ...(overrides.attributes as Record<string, unknown> | undefined),
  },
  ...overrides,
});

test('budgets 合并同币种 limit（多条累加）并取当前币种 spent 作为 differenceFloat', () => {
  const budgets = [
    budget({ id: 'b2', attributes: { name: 'Food', order: 2, spent: [{ currencyCode: 'CNY', sum: '-20' }] } }),
    budget({ id: 'b1' }),
  ];
  const limits = [
    { attributes: { budgetId: 'b1', amount: '100', currencyCode: 'CNY' } },
    { attributes: { budgetId: 'b1', amount: '20', currencyCode: 'CNY' } },
    { attributes: { budgetId: 'b1', amount: '999', currencyCode: 'EUR' } },
    { attributes: { budgetId: 'b2', amount: '50', currencyCode: 'CNY' } },
  ];

  const result = buildBudgetsBlob(budgets, limits, 'CNY');
  expect(result.map((item) => item.id)).toEqual(['b1', 'b2']);
  expect(result[0]).toMatchObject({ limit: 120, differenceFloat: -80, currencyCode: 'CNY' });
  expect(result[1]).toMatchObject({ limit: 50, differenceFloat: -20 });
  // 输入不被原地修改。
  expect(budgets[0].id).toBe('b2');
});

test('budgets 缺少 limit/spent 时回落为 0', () => {
  const result = buildBudgetsBlob([budget({ id: 'b3', attributes: { name: 'Misc', order: 0 } })], [], 'CNY');
  expect(result[0]).toMatchObject({ limit: 0, differenceFloat: 0 });
});

test('budgets 计算字段不会被服务端返回的同名字段覆盖', () => {
  const budgets = [budget({
    id: 'b1', limit: 999, differenceFloat: 999, currencyCode: 'EUR',
  })];
  const result = buildBudgetsBlob(
    budgets,
    [{ attributes: { budgetId: 'b1', amount: '100', currencyCode: 'CNY' } }],
    'CNY',
  );
  expect(result[0]).toMatchObject({ limit: 100, differenceFloat: -80, currencyCode: 'CNY' });
});

const summaryEntry = (monetaryValue: string, currencyCode = 'CNY') => ({
  title: 'x',
  monetaryValue,
  currencyCode,
  valueParsed: monetaryValue,
});

test('summary 从 /summary/basic 的键里抽取净值、收支、余额与账单', () => {
  const blob = extractSummary({
    'net-worth-in-CNY': summaryEntry('1000'),
    'balance-in-CNY': summaryEntry('200'),
    'earned-in-CNY': summaryEntry('300'),
    'spent-in-CNY': summaryEntry('-100'),
    'bills-paid-in-CNY': summaryEntry('10'),
    'bills-unpaid-in-CNY': summaryEntry('20'),
    'net-worth-in-EUR': summaryEntry('999', 'EUR'),
  }, 'CNY');

  expect(blob).toEqual({
    netWorth: [summaryEntry('1000')],
    balance: [summaryEntry('200')],
    earned: [summaryEntry('300')],
    spent: [summaryEntry('-100')],
    bills: { paid: summaryEntry('10'), unpaid: summaryEntry('20') },
  });
});

test('summary 只做精确的 `-in-<code>` 键匹配，不误命中币种子串', () => {
  const blob = extractSummary({
    'net-worth-in-CNY': summaryEntry('1000'),
    // 旧实现用 key.includes('net-worth-in-CNY')，会把这条也当成 CNY 净值。
    'net-worth-in-CNY2': summaryEntry('999', 'CNY2'),
    'balance-in-CNY': summaryEntry('200'),
    'bills-paid-in-CNY-old': summaryEntry('1'),
  }, 'CNY');

  expect(blob.netWorth).toEqual([summaryEntry('1000')]);
  expect(blob.balance).toEqual([summaryEntry('200')]);
  expect(blob.bills.paid).toBeNull();
});

test('summary 缺少账单键时 paid/unpaid 为 null', () => {
  expect(extractSummary({}, 'CNY')).toEqual({
    netWorth: [],
    balance: [],
    earned: [],
    spent: [],
    bills: { paid: null, unpaid: null },
  });
});

test('accounts 合并 frontpage display、过滤 inactive/initial-balance 并按名称升序', () => {
  const accounts = [
    { id: '1', attributes: { name: 'Wallet', active: true, type: 'asset' } },
    { id: '2', attributes: { name: 'Hidden', active: false, type: 'asset' } },
    { id: '3', attributes: { name: 'Opening', active: true, type: 'initial-balance' } },
    { id: '4', attributes: { name: 'Bank', active: true, type: 'asset' } },
  ];
  const result = buildAccountsBlob(accounts, { attributes: { data: [1, 4] } });
  expect(result.map((item) => item.id)).toEqual(['4', '1']);
  expect(result.map((item) => item.display)).toEqual([true, true]);
});

test('chart accounts 赋色、计算极值，并按币种过滤', () => {
  const result = buildChartAccountsBlob([
    { label: 'Wallet', currencyCode: 'CNY', entries: { '2026-07-01': '10', '2026-07-02': '20' } },
    { label: 'Euro', currencyCode: 'EUR', entries: { '2026-07-01': '1' } },
  ], BASE_CTX.range, 'CNY', '#FF5533');

  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    label: 'Wallet', color: '#FF5533', maxY: 20, minY: 10,
  });
  expect(result[0].entries).toEqual([
    { x: +new Date('2026-07-01'), y: 10 },
    { x: +new Date('2026-07-02'), y: 20 },
  ]);
});

test('chart accounts 先按币种过滤再赋色，品牌色落在可见序列上', () => {
  const result = buildChartAccountsBlob([
    { label: 'Euro', currencyCode: 'EUR', entries: { '2026-07-01': '1' } },
    { label: 'Wallet', currencyCode: 'CNY', entries: { '2026-07-01': '10' } },
    { label: 'Bank', currencyCode: 'CNY', entries: { '2026-07-01': '30' } },
  ], BASE_CTX.range, 'CNY', '#FF5533');

  expect(result.map((item) => item.label)).toEqual(['Wallet', 'Bank']);
  // 首个 CNY 账户必须是品牌色，第二个按 brandStyle0 起调色；旧实现会把品牌色分给 EUR 账户。
  expect(result[0].color).toBe('#FF5533');
  expect(result[1].color).toBe('#7F00FF');
});

test('chart accounts 对超过 3 个月的区间做 1/8 抽样', () => {
  const entries: Record<string, string> = {};
  for (let day = 1; day <= 24; day += 1) {
    entries[`2026-07-${String(day).padStart(2, '0')}`] = String(day);
  }
  const result = buildChartAccountsBlob(
    [{ label: 'Wallet', currencyCode: 'CNY', entries }],
    { start: '2026-01-01', end: '2026-12-31' },
    'CNY',
    '#FF5533',
  );
  // 连续三次「每 2 个取 1 个」= 每 8 个取 1 个 → 第 1、9、17 天。
  expect(result[0].entries.map((point) => point.y)).toEqual([1, 9, 17]);
});

test('bills 过滤 inactive、累加本地交易金额并按到期日排序', () => {
  const bills = [
    {
      id: 'b1',
      attributes: {
        name: 'Rent', active: true, nextExpectedMatch: '2026-10-20T00:00:00Z', paidDates: [],
      },
    },
    {
      id: 'b2',
      attributes: {
        name: 'Old', active: false, nextExpectedMatch: null, paidDates: [],
      },
    },
  ];
  const result = buildBillsBlob(bills, [
    { billId: 'b1', amount: '12.5' },
    { billId: 'b1', amount: '2.5' },
    { billId: 'other', amount: '99' },
  ]);
  expect(result).toHaveLength(1);
  expect(result[0].attributes.currentPaidAmount).toBe('15');
});

// ---------------------------------------------------------------------------
// pullBlobs：并发、归一化、失败隔离与修剪

type BlobRow = { payload: string; fetchedAt: string };

const createFakeDb = (initial: Record<string, unknown> = {}, transactions: unknown[] = []) => {
  const blobs = new Map<string, BlobRow>();
  const rowKey = (scopeId: string, key: string) => `${scopeId}|${key}`;
  const statements: string[] = [];
  Object.keys(initial).forEach((key) => {
    blobs.set(rowKey('scope1', key), {
      payload: JSON.stringify(initial[key]),
      fetchedAt: '2026-10-27T00:00:00.000Z',
    });
  });
  const check = (sql: string, params: unknown[]) => {
    const marks = sql.split('?').length - 1;
    if (marks !== params.length) {
      throw new Error(`placeholder/param mismatch (${marks} vs ${params.length}): ${sql}`);
    }
    if (!/scope_id/.test(sql)) {
      throw new Error(`missing scope_id: ${sql}`);
    }
    if (params[0] !== 'scope1') {
      throw new Error(`first param is not scopeId: ${sql}`);
    }
  };

  const db: Db = {
    exec: async () => {},
    run: async (sql, params = []) => {
      statements.push(sql);
      check(sql, params);
      if (/^INSERT OR REPLACE INTO blobs/i.test(sql)) {
        const [scopeId, key, payload, fetchedAt] = params as [string, string, string, string];
        blobs.set(rowKey(scopeId, key), { payload, fetchedAt });
        return;
      }
      const deleteAll = /^DELETE FROM blobs WHERE scope_id = \?$/i.test(sql);
      const deleteKeep = /^DELETE FROM blobs WHERE scope_id = \? AND key NOT IN \(/i.test(sql);
      if (deleteAll || deleteKeep) {
        const [scopeId, ...keep] = params as [string, ...string[]];
        const prefix = `${scopeId}|`;
        [...blobs.keys()]
          .filter((rk) => rk.startsWith(prefix))
          .forEach((rk) => {
            const name = rk.slice(prefix.length);
            if (deleteAll || !keep.includes(name)) {
              blobs.delete(rk);
            }
          });
        return;
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    all: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      statements.push(sql);
      check(sql, params);
      if (/SELECT key FROM blobs WHERE scope_id = \?$/i.test(sql.trim())) {
        const prefix = `${params[0]}|`;
        return [...blobs.keys()]
          .filter((rk) => rk.startsWith(prefix))
          .map((rk) => ({ key: rk.slice(prefix.length) }) as T);
      }
      if (/FROM transactions\s+WHERE scope_id = \?/i.test(sql)) {
        return transactions.map((payload) => ({ payload: JSON.stringify(payload) }) as T);
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    get: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      check(sql, params);
      if (/FROM blobs WHERE scope_id = \? AND key = \?/i.test(sql)) {
        const [scopeId, key] = params as [string, string];
        const row = blobs.get(rowKey(scopeId, key));
        return (row ? { ...row } : null) as T;
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
  return { db, blobs, statements };
};

type FakeRule = { match: RegExp; body: unknown } | { match: RegExp; error: Error };

const createFakeHttp = (rules: FakeRule[]) => {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const http = {
    get: async (url: string) => {
      calls.push(url);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // 让多个请求有机会真正并发，才能观察到并发上限。
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        const rule = rules.find((candidate) => candidate.match.test(url));
        if (!rule) {
          throw new Error(`unexpected url: ${url}`);
        }
        if ('error' in rule) {
          throw rule.error;
        }
        return { data: rule.body };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return {
    http,
    calls,
    maxInFlight: () => maxInFlight,
  };
};

const RESPONSES: FakeRule[] = [
  {
    match: /\/currencies\/CNY\/accounts/,
    body: {
      data: [
        {
          id: '1',
          attributes: {
            name: 'Wallet', active: true, type: 'asset', current_balance: '10',
          },
        },
        { id: '2', attributes: { name: 'Off', active: false, type: 'asset' } },
      ],
    },
  },
  { match: /preferences\/frontpageAccounts/, body: { data: { attributes: { data: [1] } } } },
  {
    match: /insight\/expense\/category/,
    body: {
      data: [{
        id: 'c1', name: 'Food', currency_code: 'CNY', currency_id: '1', difference_float: -30,
      }],
    },
  },
  {
    match: /insight\/expense\/no-category/,
    body: {
      data: [{
        id: 'x', name: 'x', currency_code: 'CNY', currency_id: '1', difference_float: -5,
      }],
    },
  },
  {
    match: /insight\/income\/category/,
    body: {
      data: [{
        id: 'c1', name: 'Food', currency_code: 'CNY', currency_id: '1', difference_float: 50,
      }],
    },
  },
  { match: /insight\/income\/no-category/, body: { data: [] } },
  {
    match: /\/api\/v1\/budgets\?/,
    body: {
      data: [
        {
          id: 'b1',
          attributes: {
            name: 'Rent', active: true, order: 1, spent: [{ currency_code: 'CNY', sum: '-80' }],
          },
        },
      ],
    },
  },
  {
    match: /budget-limits/,
    body: { data: [{ attributes: { budget_id: 'b1', amount: '100', currency_code: 'CNY' } }] },
  },
  {
    match: /summary\/basic/,
    body: {
      'net-worth-in-CNY': { title: 'n', monetary_value: '1000', currency_code: 'CNY' },
      'balance-in-CNY': { title: 'b', monetary_value: '200', currency_code: 'CNY' },
      'earned-in-CNY': { title: 'e', monetary_value: '300', currency_code: 'CNY' },
      'spent-in-CNY': { title: 's', monetary_value: '-100', currency_code: 'CNY' },
      'bills-paid-in-CNY': { title: 'p', monetary_value: '10', currency_code: 'CNY' },
      'bills-unpaid-in-CNY': { title: 'u', monetary_value: '20', currency_code: 'CNY' },
    },
  },
  {
    match: /chart\/account\/overview/,
    body: {
      data: [
        { label: 'Wallet', currency_code: 'CNY', entries: { '2026-07-01': '10', '2026-07-02': '20' } },
        { label: 'Euro', currency_code: 'EUR', entries: { '2026-07-01': '1' } },
      ],
    },
  },
  { match: /\/accounts\?type=asset&date=/, body: { data: [{ id: '1', type: 'asset' }] } },
  {
    match: /chart\/balance\/balance/,
    body: {
      data: [
        { label: 'earned', currency_code: 'CNY', entries: { '2026-07-01': '100' } },
        { label: 'spent', currency_code: 'CNY', entries: { '2026-07-01': '-40' } },
      ],
    },
  },
  { match: /autocomplete\/accounts/, body: [{ id: 1, name: 'Cash', type: 'Asset account' }] },
  { match: /autocomplete\/categories/, body: [{ id: 2, name: 'Food' }] },
  { match: /autocomplete\/budgets/, body: [{ id: 3, name: 'Rent' }] },
  { match: /autocomplete\/bills/, body: [{ id: 4, name: 'Power' }] },
  { match: /autocomplete\/tags/, body: [{ id: 5, name: 'travel' }] },
  {
    match: /\/api\/v1\/bills\?/,
    body: {
      data: [
        {
          id: 'b1',
          attributes: {
            name: 'Rent', active: true, next_expected_match: '2026-10-20', paid_dates: [],
          },
        },
        { id: 'b2', attributes: { name: 'Old', active: false, paid_dates: [] } },
      ],
    },
  },
  { match: /piggy-banks/, body: { data: [{ id: 'p1', attributes: { name: 'Trip' } }] } },
  {
    match: /\/api\/v1\/currencies$/,
    body: {
      data: [
        { id: '1', attributes: { enabled: true, default: true, code: 'CNY' } },
        { id: '2', attributes: { enabled: false, default: false, code: 'USD' } },
      ],
    },
  },
];

const billTransactions = [{
  id: '1',
  attributes: {
    transactions: [
      { billId: 'b1', amount: '12.5' },
      { billId: 'b1', amount: '2.5' },
    ],
  },
}];

const payloadOf = <T>(blobs: Map<string, BlobRow>, key: string): T => {
  const row = blobs.get(`scope1|${key}`);
  if (!row) {
    throw new Error(`missing blob: ${key}`);
  }
  return JSON.parse(row.payload) as T;
};

test('pullBlobs 并发不超过 4，写入全部规范形状并修剪旧区间', async () => {
  const initial = {
    'summary:2024-01-01:2024-03-31:CNY': { old: 1 },
    'summary:2024-04-01:2024-06-30:CNY': { old: 1 },
    'summary:2024-07-01:2024-09-30:CNY': { old: 1 },
    'summary:2024-10-01:2024-12-31:CNY': { old: 1 },
    'summary:2025-01-01:2025-03-31:CNY': { old: 1 },
    // 当前区间但不在本轮计划里的维度：必须保留。
    'accounts:2026-07-01:2026-09-30:CNY:asset': [{ id: 'keep' }],
  };
  const { db, blobs } = createFakeDb(initial, billTransactions);
  const fake = createFakeHttp(RESPONSES);

  const written = await pullBlobs(db, 'scope1', ctxWith({ http: fake.http as never }));

  expect(written).toBe(14);
  expect(fake.maxInFlight()).toBeLessThanOrEqual(4);

  // accounts：snake_case 归一化 + display 合并 + 过滤 inactive。
  const accounts = payloadOf<Array<{ id: string; display: boolean; attributes: { currentBalance: string } }>>(
    blobs,
    'accounts:2026-07-01:2026-09-30:CNY:all',
  );
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({ id: '1', display: true });
  expect(accounts[0].attributes.currentBalance).toBe('10');

  const categories = payloadOf<{ total: { difference: number } }>(blobs, 'categories:2026-07-01:2026-09-30:CNY');
  expect(categories.total.difference).toBe(15);

  const budgets = payloadOf<Array<{ id: string; limit: number }>>(blobs, 'budgets:2026-07-01:2026-09-30:CNY');
  expect(budgets[0]).toMatchObject({ id: 'b1', limit: 100 });

  const summary = payloadOf<{ netWorth: Array<{ monetaryValue: string }> }>(
    blobs,
    'summary:2026-07-01:2026-09-30:CNY',
  );
  expect(summary.netWorth[0].monetaryValue).toBe('1000');

  const charts = payloadOf<Array<{ label: string; entries: unknown[] }>>(
    blobs,
    'chart:accounts:2026-07-01:2026-09-30:CNY:all',
  );
  expect(charts).toHaveLength(1);
  expect(charts[0].entries).toHaveLength(2);

  const balance = payloadOf<{ earnedChart: Array<{ y: number }> }>(
    blobs,
    'chart:balance:2026-07-01:2026-09-30:CNY',
  );
  expect(balance.earnedChart[0].y).toBe(100);

  // autocomplete 规范形状：数字 id 转字符串，type 仅账户保留。
  expect(payloadOf(blobs, 'autocomplete:accounts')).toEqual([{ id: '1', name: 'Cash', type: 'Asset account' }]);
  expect(payloadOf(blobs, 'autocomplete:categories')).toEqual([{ id: '2', name: 'Food' }]);

  // bills：过滤 inactive + 本地交易金额合并。
  const bills = payloadOf<Array<{ id: string; attributes: { currentPaidAmount: string } }>>(blobs, 'bills');
  expect(bills).toHaveLength(1);
  expect(bills[0].attributes.currentPaidAmount).toBe('15');

  expect(payloadOf(blobs, 'piggy_banks')).toHaveLength(1);
  expect(payloadOf(blobs, 'currencies')).toMatchObject({ currentCode: 'CNY' });

  // 修剪：保留当前 + 最近 3 个区间，最旧两组被删除；当前区间的非计划键保留。
  expect(blobs.has('scope1|summary:2024-01-01:2024-03-31:CNY')).toBe(false);
  expect(blobs.has('scope1|summary:2024-04-01:2024-06-30:CNY')).toBe(false);
  expect(blobs.has('scope1|summary:2024-07-01:2024-09-30:CNY')).toBe(true);
  expect(blobs.has('scope1|summary:2025-01-01:2025-03-31:CNY')).toBe(true);
  expect(blobs.has('scope1|accounts:2026-07-01:2026-09-30:CNY:asset')).toBe(true);
  expect(blobs.has('scope1|autocomplete:tags')).toBe(true);
});

test('pullBlobs 单个键失败不阻断其他键，返回成功条数', async () => {
  const { db, blobs } = createFakeDb();
  const rules: FakeRule[] = [
    { match: /piggy-banks/, error: new Error('boom') },
    ...RESPONSES,
  ];
  const fake = createFakeHttp(rules);

  const written = await pullBlobs(db, 'scope1', ctxWith({ http: fake.http as never }));

  expect(written).toBe(13);
  expect(blobs.has('scope1|piggy_banks')).toBe(false);
  expect(blobs.has('scope1|bills')).toBe(true);
  expect(blobs.has('scope1|currencies')).toBe(true);
});

test('pullBlobs 低频键新鲜时跳过请求但不会被修剪', async () => {
  const { db, blobs } = createFakeDb();
  // 先写入新鲜的低频数据（fetchedAt 由 writeBlob 默认取当前时间）。
  blobs.set('scope1|bills', { payload: '[{"id":"old"}]', fetchedAt: new Date().toISOString() });
  blobs.set('scope1|piggy_banks', { payload: '[]', fetchedAt: new Date().toISOString() });
  blobs.set('scope1|currencies', { payload: '{"currentCode":"CNY","currencies":[]}', fetchedAt: new Date().toISOString() });
  const fake = createFakeHttp(RESPONSES);

  const written = await pullBlobs(db, 'scope1', ctxWith({ http: fake.http as never }));

  expect(written).toBe(11);
  expect(fake.calls.some((url) => /piggy-banks/.test(url))).toBe(false);
  expect(fake.calls.some((url) => /\/api\/v1\/bills\?/.test(url))).toBe(false);
  expect(fake.calls.some((url) => /\/api\/v1\/currencies$/.test(url))).toBe(false);
  expect(payloadOf(blobs, 'bills')).toEqual([{ id: 'old' }]);
});

test('pullBlobs 本轮零写入时不修剪旧缓存', async () => {
  const initial = {
    'summary:2024-01-01:2024-03-31:CNY': { old: 1 },
    'summary:2025-01-01:2025-03-31:CNY': { old: 1 },
  };
  const { db, blobs, statements } = createFakeDb(initial);
  const fake = createFakeHttp([{ match: /.*/, error: new Error('offline') }]);

  const written = await pullBlobs(db, 'scope1', ctxWith({ http: fake.http as never }));

  expect(written).toBe(0);
  // 所有请求都失败：即使旧区间已超出保留窗口，也不能删任何键。
  expect(blobs.has('scope1|summary:2024-01-01:2024-03-31:CNY')).toBe(true);
  expect(blobs.has('scope1|summary:2025-01-01:2025-03-31:CNY')).toBe(true);
  expect(statements.some((sql) => /^DELETE FROM blobs/i.test(sql))).toBe(false);
});
