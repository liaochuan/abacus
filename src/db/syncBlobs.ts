import type { AxiosInstance } from 'axios';
import semver from 'semver';

import { convertKeysToCamelCase } from '../lib/case';
import colors from '../constants/colors';
import type { AutocompleteKind, AutocompleteOption } from './autocomplete';
import { blobKeys } from './keys';
import {
  pruneBlobs,
  readBlob,
  selectKeysToPrune,
  writeBlob,
} from './repository';
import { isStale } from './staleness';
import type { Db } from './types';

// 同步引擎的 blob 刷新：把 Firefly 的聚合端点抓下来，按规范形状写进 blobs 表。
// 只依赖 ctx.http（token 刷新与 401 重试由 runSync / withAuthRetry 负责），
// 本文件不打任何日志：错误信息只有固定短句，不含 payload、账户名、备注或 token。
//
// 键与形状对齐 spec §7.3（docs/superpowers/specs/2026-10-26-offline-sync-design.md）：
// - 同一份数据在不同区间 / 币种 / 过滤开关下是不同的快照，键必须带全维度；
// - 低频数据（bills / piggy_banks / currencies）只在缺失或超过 1 小时时刷新；
// - autocomplete 只在缺失或超过 30 分钟时刷新（新增一笔交易不影响候选集）。

// 完整 SyncContext（src/db/sync.ts）是本类型的超集：runSync 组装出的上下文可直接结构化赋值。
// selectedBrandStyle 不属于同步上下文，缺省时用默认品牌色（图表颜色只是展示细节）。
export type BlobSyncContext = {
  backendURL: string;
  accessToken: string;
  http: AxiosInstance;
  range: { start: string; end: string };
  currencyCode: string;
  displayAllAccounts: boolean;
  apiVersion: string;
  refreshToken(): Promise<string>;
  selectedBrandStyle?: string;
};

// BlobKind 决定需要哪种聚合（一个 kind 可能对应多个 HTTP 端点）。
export type BlobKind =
  | 'accounts'
  | 'categories'
  | 'budgets'
  | 'summary'
  | 'chartAccounts'
  | 'chartBalance'
  | 'autocomplete'
  | 'bills'
  | 'piggyBanks'
  | 'currencies';

export type BlobPlanItem = {
  key: string;
  // 该 kind 的主请求地址（多端点 kind 的其余端点在 pullBlobs 里派生）。
  // 低频键被门控时 URL 只用于诊断，不会真的请求。
  url: string;
  kind: BlobKind;
  // kind === 'autocomplete' 时必须存在，用于区分 5 个缓存键。
  autocompleteKind?: AutocompleteKind;
};

export type BlobPlanOptions = {
  /**
   * 已判定需要刷新的键集合（`bills` / `piggy_banks` / `currencies` / `autocomplete:*`）。
   * 省略 = 空集合 = 不刷新任何到期键；只有显式传入的集合才纳入计划。
   * 这样 planBlobRefresh 保持纯函数，读库的过期判断由 lowFrequencyRefreshSet 完成。
   */
  staleLowFrequency?: Set<string>;
};

const AUTOCOMPLETE_KINDS: AutocompleteKind[] = ['accounts', 'categories', 'budgets', 'bills', 'tags'];

// Firefly autocomplete 默认只回 10 条；离线缓存要覆盖一整个表单的候选，取一个更大的上限。
const AUTOCOMPLETE_LIMIT = 100;

export const LOW_FREQUENCY_TTL_MS = 60 * 60 * 1000;

// autocomplete 的候选集只随账户/分类/预算/账单/标签本身变化，新增一笔交易影响不到它。
// 30 分钟刷新一次即可，避免每次保存都重复拉 5 个键。
export const AUTOCOMPLETE_TTL_MS = 30 * 60 * 1000;

// 与 spec §7.3 的淘汰策略一致：当前区间 + 最近 3 个区间组合。
const KEEP_RANGE_COMBINATIONS = 3;

// Firefly 的聚合端点并发上限（按计划项计）。
const FETCH_CONCURRENCY = 4;

// 请求级的全局上限：计划项之间最多 4 个同时处理，categories 项内部还会再并发 4 个请求，
// 合计最多 8 个 HTTP 在飞。用信号量统一约束，避免把小规模自建 Firefly 打满。
export const MAX_IN_FLIGHT_REQUESTS = FETCH_CONCURRENCY * 2;

let activeRequests = 0;
const requestWaiters: Array<() => void> = [];

// 取得一个请求名额：满额时挂起，由释放方直接把名额转交（activeRequests 保持不变）。
async function acquireRequestSlot(): Promise<void> {
  if (activeRequests < MAX_IN_FLIGHT_REQUESTS) {
    activeRequests += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    requestWaiters.push(resolve);
  });
}

function releaseRequestSlot(): void {
  const next = requestWaiters.shift();
  if (next !== undefined) {
    next();
    return;
  }
  activeRequests -= 1;
}

const rangeQuery = (range: { start: string; end: string }): string => `start=${range.start}&end=${range.end}`;

const accountsUrl = (ctx: BlobSyncContext): string => {
  const typeFilter = ctx.displayAllAccounts ? '' : 'type=asset&';
  return `${ctx.backendURL}/api/v1/currencies/${encodeURIComponent(ctx.currencyCode)}/accounts?${typeFilter}${rangeQuery(ctx.range)}&date=${ctx.range.end}`;
};

const insightUrl = (ctx: BlobSyncContext, path: string): string => (
  `${ctx.backendURL}/api/v1/insight/${path}?${rangeQuery(ctx.range)}`
);

const budgetsUrl = (ctx: BlobSyncContext): string => (
  `${ctx.backendURL}/api/v1/budgets?${rangeQuery(ctx.range)}`
);

const budgetLimitsUrl = (ctx: BlobSyncContext): string => (
  `${ctx.backendURL}/api/v1/budget-limits?${rangeQuery(ctx.range)}`
);

const summaryUrl = (ctx: BlobSyncContext): string => (
  `${ctx.backendURL}/api/v1/summary/basic?${rangeQuery(ctx.range)}&currency_code=${encodeURIComponent(ctx.currencyCode)}`
);

const chartAccountsUrl = (ctx: BlobSyncContext): string => (
  `${ctx.backendURL}/api/v1/chart/account/overview?${rangeQuery(ctx.range)}&preselected=${ctx.displayAllAccounts ? 'all' : ''}`
);

const chartBalanceEndpoint = (apiVersion: string): string => (
  semver.valid(apiVersion) !== null && semver.gte(apiVersion, '6.3.0')
    ? '/api/v1/chart/balance/balance'
    : '/api/v2/chart/balance/balance'
);

const chartBalanceAccountsUrl = (ctx: BlobSyncContext): string => (
  `${ctx.backendURL}/api/v1/accounts?type=asset&date=${ctx.range.end}`
);

// 导出给测试与诊断：账户 id 只有在运行时拉完资产账户后才知道，因此计划里的 URL 不带过滤参数。
export function buildBalanceChartUrl(
  backendURL: string,
  range: { start: string; end: string },
  apiVersion: string,
  accountIds: Array<string | number>,
): string {
  const base = `${backendURL}${chartBalanceEndpoint(apiVersion)}?${rangeQuery(range)}`;
  if (accountIds.length === 0) {
    return base;
  }
  return `${base}&filter[accounts][]=${accountIds.join('&filter[accounts][]=')}`;
}

const autocompleteUrl = (ctx: BlobSyncContext, kind: AutocompleteKind): string => (
  `${ctx.backendURL}/api/v1/autocomplete/${kind}?limit=${AUTOCOMPLETE_LIMIT}&query=`
);

const billsUrl = (ctx: BlobSyncContext): string => (
  `${ctx.backendURL}/api/v1/bills?${rangeQuery(ctx.range)}`
);

const piggyBanksUrl = (ctx: BlobSyncContext): string => `${ctx.backendURL}/api/v1/piggy-banks`;

const currenciesUrl = (ctx: BlobSyncContext): string => `${ctx.backendURL}/api/v1/currencies`;

// 纯函数：当前区间 + 币种 + 过滤开关对应的完整键集合。
// 低频键（bills / piggy_banks / currencies）与 autocomplete 是否纳入由调用方按各自 TTL 决定
// （见 lowFrequencyRefreshSet），其余键每轮都刷新。
// 顺序固定，便于测试与诊断：accounts → categories → budgets → summary → chart:* → autocomplete:* → 低频键。
export function planBlobRefresh(
  ctx: BlobSyncContext,
  options: BlobPlanOptions = {},
): BlobPlanItem[] {
  const { start, end } = ctx.range;
  const code = ctx.currencyCode;
  // 缺省为空集合：低频键与 autocomplete 不会因为「调用方忘了传集合」而每轮都请求。
  // 首轮同步与过期刷新都由 lowFrequencyRefreshSet 显式算出集合，再由 pullBlobs 传入。
  const gated = options.staleLowFrequency ?? new Set<string>();
  const includeDue = (key: string): boolean => gated.has(key);

  const plan: BlobPlanItem[] = [
    {
      key: blobKeys.accounts(start, end, code, ctx.displayAllAccounts),
      url: accountsUrl(ctx),
      kind: 'accounts',
    },
    {
      key: blobKeys.categories(start, end, code),
      url: insightUrl(ctx, 'expense/category'),
      kind: 'categories',
    },
    {
      key: blobKeys.budgets(start, end, code),
      url: budgetsUrl(ctx),
      kind: 'budgets',
    },
    {
      key: blobKeys.summary(start, end, code),
      url: summaryUrl(ctx),
      kind: 'summary',
    },
    {
      key: blobKeys.chartAccounts(start, end, code, ctx.displayAllAccounts),
      url: chartAccountsUrl(ctx),
      kind: 'chartAccounts',
    },
    {
      key: blobKeys.chartBalance(start, end, code),
      // 版本分支决定 v1 / v2；账户过滤参数在运行时补。
      url: buildBalanceChartUrl(ctx.backendURL, ctx.range, ctx.apiVersion, []),
      kind: 'chartBalance',
    },
  ];

  AUTOCOMPLETE_KINDS.forEach((kind) => {
    const key = blobKeys.autocomplete(kind);
    if (!includeDue(key)) {
      return;
    }
    plan.push({
      key,
      url: autocompleteUrl(ctx, kind),
      kind: 'autocomplete',
      autocompleteKind: kind,
    });
  });

  if (includeDue(blobKeys.bills())) {
    plan.push({ key: blobKeys.bills(), url: billsUrl(ctx), kind: 'bills' });
  }
  if (includeDue(blobKeys.piggyBanks())) {
    plan.push({ key: blobKeys.piggyBanks(), url: piggyBanksUrl(ctx), kind: 'piggyBanks' });
  }
  if (includeDue(blobKeys.currencies())) {
    plan.push({ key: blobKeys.currencies(), url: currenciesUrl(ctx), kind: 'currencies' });
  }

  return plan;
}

// ---------------------------------------------------------------------------
// 响应归一化与形状辅助

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

// Firefly 多数端点把数组包在 { data: ... } 里，summary/autocomplete 则直接是裸对象或数组。
const dataOf = (body: unknown): unknown => (
  isRecord(body) && Object.hasOwn(body, 'data') ? body.data : body
);

const arrayOf = (body: unknown): unknown[] => {
  const value = dataOf(body);
  return Array.isArray(value) ? value : [];
};

// 金额字段在不同端点里可能是字符串或数字；无法解析时按 0 处理，避免把 NaN 写进 blob。
const toNumber = (value: unknown): number => {
  const parsed = parseFloat(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

export type AccountLike = {
  id?: string | number;
  display?: boolean;
  attributes?: {
    name?: string;
    active?: boolean;
    type?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

// 对齐 models/accounts.ts#getAccounts：
// - 服务端已按 displayAllAccounts 过滤（type=asset），这里不再二次过滤类型；
// - 过滤 inactive 与 initial-balance；
// - display 来自 /preferences/frontpageAccounts 的 id 列表；
// - 按名称升序。旧实现在过滤前就写 display，因此过滤后的对象仍带着它。
export function buildAccountsBlob(accounts: AccountLike[], preference: unknown): AccountLike[] {
  const selected = new Set<number>();
  const attributes = isRecord(preference) && isRecord(preference.attributes)
    ? preference.attributes
    : null;
  if (attributes !== null && Array.isArray(attributes.data)) {
    attributes.data.forEach((value) => {
      const id = Number(value);
      if (Number.isFinite(id)) {
        selected.add(id);
      }
    });
  }

  return accounts
    .map((account) => ({ ...account, display: selected.has(Number(account.id)) }))
    .filter((account) => account.attributes?.active === true && account.attributes?.type !== 'initial-balance')
    .sort((a, b) => {
      const left = a.attributes?.name ?? '';
      const right = b.attributes?.name ?? '';
      if (left === right) {
        return 0;
      }
      return left < right ? -1 : 1;
    });
}

export type InsightCategoryInput = {
  name?: string;
  id?: string;
  currencyCode?: string;
  currencyId?: string;
  difference?: string;
  differenceFloat?: number;
  [key: string]: unknown;
};

export type InsightCategory = {
  name: string;
  id: string;
  currencyCode: string;
  currencyId: string;
  income: number;
  expense: number;
  difference: number;
  [key: string]: unknown;
};

export type CategoriesBlob = {
  insightCategories: InsightCategory[];
  total: InsightCategory;
  // 区间内没有当前币种的分类时不产出（旧实现同样只在 filteredCategories 非空时设置）。
  perDay?: InsightCategory;
};

// 对齐 models/categories.ts#getInsightCategories 的聚合：四个 insight 端点合并成
// { insightCategories, total, perDay }。日期差按本地日历日计算，end 未来时截到 now。
export function dateDiffInDays(start: string, end: string, now: Date = new Date()): number {
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  const from = new Date(start);
  const to = new Date(end).getTime() > now.getTime() ? now : new Date(end);
  const utc1 = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const utc2 = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  // 至少 1 天：避免「区间整体在未来」时 perDay 变成 Infinity（JSON 会序列化成 null）。
  return Math.max(1, Math.floor((utc2 - utc1) / MS_PER_DAY) + 1);
}

export function buildCategoriesBlob(
  expense: InsightCategoryInput[],
  noCategoryExpense: InsightCategoryInput[],
  income: InsightCategoryInput[],
  noCategoryIncome: InsightCategoryInput[],
  currencyCode: string,
  start: string,
  end: string,
  now: Date = new Date(),
): CategoriesBlob {
  // 不修改入参：旧实现直接 push 进服务端返回的数组。
  const expenseItems = [...expense];
  const incomeItems = [...income];

  [...noCategoryExpense, ...noCategoryIncome].forEach((item) => {
    const normalized = { ...item, id: 'no-cat', name: 'no-category' };
    if (toNumber(item.differenceFloat) > 0) {
      incomeItems.push(normalized);
    } else {
      expenseItems.push(normalized);
    }
  });

  const byId = new Map<string, InsightCategory>();
  [...expenseItems, ...incomeItems].forEach((category) => {
    const id = typeof category.id === 'string' ? category.id : String(category.id ?? '');
    const categoryCurrency = typeof category.currencyCode === 'string' ? category.currencyCode : '';
    // insight 端点按币种各回一行：同 id 的 c1(CNY) 与 c1(EUR) 是两个不同的分类行。
    // 只按 id 合并会把它们加在一起，再按币种过滤时丢掉别的币种金额却保留污染后的合计。
    const mergeKey = `${id}:${categoryCurrency}`;
    const difference = toNumber(category.differenceFloat);
    const existing = byId.get(mergeKey);

    if (existing === undefined) {
      byId.set(mergeKey, {
        ...category,
        name: typeof category.name === 'string' ? category.name : '',
        id,
        currencyCode: categoryCurrency,
        currencyId: typeof category.currencyId === 'string' ? category.currencyId : '',
        income: difference > 0 ? difference : 0,
        expense: difference < 0 ? difference : 0,
        difference,
      });
      return;
    }

    if (difference > 0) {
      existing.income += difference;
    } else {
      existing.expense += difference;
    }
    existing.difference += difference;
  });

  const total: InsightCategory = {
    name: 'total',
    id: 'total',
    currencyCode: '',
    currencyId: '0',
    income: 0,
    expense: 0,
    difference: 0,
  };

  const insightCategories = [...byId.values()]
    .filter((category) => category.currencyCode === currencyCode)
    .map((category) => {
      total.income += category.income;
      total.expense += category.expense;
      total.difference += category.difference;
      return category;
    })
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

  let perDay: InsightCategory | undefined;
  if (insightCategories.length > 0) {
    total.currencyCode = insightCategories[0].currencyCode;
    total.currencyId = insightCategories[0].currencyId;

    const days = dateDiffInDays(start, end, now);
    perDay = {
      ...total,
      name: 'perday',
      id: 'perday',
      income: total.income / days,
      expense: total.expense / days,
      difference: total.difference / days,
    };
  }

  return { insightCategories, total, perDay };
}

export type BudgetLike = {
  id?: string;
  attributes?: {
    name?: string;
    active?: boolean;
    order?: number;
    spent?: Array<{ currencyCode?: string; sum?: string | number; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type BudgetLimitLike = {
  attributes?: {
    budgetId?: string;
    amount?: string | number;
    currencyCode?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type BudgetBlobItem = BudgetLike & {
  id: string;
  limit: number;
  currencyCode: string;
  differenceFloat: number;
};

// 对齐 models/budgets.ts#getInsightBudgets：
// - budget-limits 只统计当前币种，同一 budget 的多条金额累加；
// - differenceFloat 取 attributes.spent 中当前币种的 sum（旧实现原样存字符串，
//   这里按模型声明的 number 解析，UI 的算术结果不变）；
// - 按 attributes.order 升序。
export function buildBudgetsBlob(
  budgets: BudgetLike[],
  limits: BudgetLimitLike[],
  currencyCode: string,
): BudgetBlobItem[] {
  const limitByBudget = new Map<string, number>();
  limits.forEach((limit) => {
    const { attributes } = limit;
    if (attributes === undefined || attributes.currencyCode !== currencyCode) {
      return;
    }
    const budgetId = attributes.budgetId ?? '';
    limitByBudget.set(budgetId, (limitByBudget.get(budgetId) ?? 0) + toNumber(attributes.amount));
  });

  return [...budgets]
    .sort((a, b) => (a.attributes?.order ?? 0) - (b.attributes?.order ?? 0))
    .map((budget) => {
      const spent = Array.isArray(budget.attributes?.spent)
        ? budget.attributes.spent.find((entry) => entry.currencyCode === currencyCode)
        : undefined;
      // 服务端字段展开在前，计算字段在后：否则 budget 里同名键会悄悄覆盖 limit/differenceFloat。
      return {
        ...budget,
        limit: limitByBudget.get(budget.id ?? '') ?? 0,
        differenceFloat: toNumber(spent?.sum),
        currencyCode,
      } as BudgetBlobItem;
    });
}

export type SummaryDisplay = {
  title?: string;
  valueParsed?: string;
  monetaryValue?: string;
  currencyCode?: string;
  [key: string]: unknown;
};

export type SummaryBlob = {
  netWorth: SummaryDisplay[];
  balance: SummaryDisplay[];
  earned: SummaryDisplay[];
  spent: SummaryDisplay[];
  bills: { paid: SummaryDisplay | null; unpaid: SummaryDisplay | null };
};

// 对齐 models/firefly.ts#getNetWorth：/summary/basic 的键名带币种后缀，
// 按 `*-in-<code>` 归类；账单键同时给出 paid / unpaid。
export function extractSummary(summary: Record<string, unknown>, currencyCode: string): SummaryBlob {
  const netWorth: SummaryDisplay[] = [];
  const balance: SummaryDisplay[] = [];
  const earned: SummaryDisplay[] = [];
  const spent: SummaryDisplay[] = [];
  const bills: SummaryBlob['bills'] = { paid: null, unpaid: null };

  Object.keys(summary).forEach((key) => {
    const value = summary[key];
    if (!isRecord(value)) {
      return;
    }
    const display = value as SummaryDisplay;
    // 精确等值匹配：includes('net-worth-in-CNY') 会误命中别的币种（例如 CNY 是更长代码的子串）。
    switch (key) {
      case `net-worth-in-${currencyCode}`:
        netWorth.push(display);
        break;
      case `balance-in-${currencyCode}`:
        balance.push(display);
        break;
      case `earned-in-${currencyCode}`:
        earned.push(display);
        break;
      case `spent-in-${currencyCode}`:
        spent.push(display);
        break;
      case `bills-paid-in-${currencyCode}`:
        bills.paid = display;
        break;
      case `bills-unpaid-in-${currencyCode}`:
        bills.unpaid = display;
        break;
      default:
        break;
    }
  });

  return {
    netWorth, balance, earned, spent, bills,
  };
}

export type ChartAccountLike = {
  label?: string;
  currencyCode?: string;
  entries?: Record<string, unknown>;
  [key: string]: unknown;
};

export type AssetAccountChart = {
  label?: string;
  currencyCode?: string;
  entries: Array<{ x: number; y: number }>;
  color: string;
  maxY: number;
  minY: number;
  [key: string]: unknown;
};

// 把区间起止换算成「月数」，用于复刻 rangeDetails.range（1/3/6/12）的抽样阈值。
export function rangeLengthInMonths(start: string, end: string): number {
  const from = new Date(start);
  const to = new Date(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return 1;
  }
  return Math.max(1, (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) + 1);
}

// entries 抽样与旧实现一致：连续三次「每 2 个取 1 个」= 每 8 个取 1 个。
const sampleEntries = (keys: string[]): string[] => {
  let current = keys;
  for (let pass = 0; pass < 3; pass += 1) {
    current = current.filter((_, index) => index % 2 === 0);
  }
  return current;
};

// 对齐 models/firefly.ts#getAccountChart：逐账户赋色、计算 maxY/minY，超过 3 个月的区间抽样。
// 先按币种过滤再赋色：否则首个其他币种的账户会吃掉 selectedBrandStyle，可见序列拿不到品牌色、
// 调色板也会整体错位。
export function buildChartAccountsBlob(
  accounts: ChartAccountLike[],
  range: { start: string; end: string },
  currencyCode: string,
  selectedBrandStyle: string = colors.brandStyleOrange,
): AssetAccountChart[] {
  const brandColors = colors as unknown as Record<string, string>;
  const months = rangeLengthInMonths(range.start, range.end);
  let colorIndex = 0;

  return accounts
    .filter((account) => account.currencyCode === currencyCode)
    .map((account, index) => {
      const rawEntries = isRecord(account.entries) ? account.entries : {};
      const keys = Object.keys(rawEntries);
      const entryKeys = months > 3 ? sampleEntries(keys) : keys;
      const entries = entryKeys.map((key) => ({
        x: +new Date(key),
        y: toNumber(rawEntries[key]),
      }));

      let color: string;
      if (index === 0) {
        color = selectedBrandStyle;
      } else {
        if (colorIndex >= 6) {
          colorIndex = 0;
        }
        color = brandColors[`brandStyle${colorIndex}`] ?? brandColors.brandStyle;
        colorIndex += 1;
      }

      return {
        ...account,
        color,
        entries,
        maxY: entries.length === 0 ? 0 : entries.reduce((max, point) => Math.max(max, point.y), -Infinity),
        minY: entries.length === 0 ? 0 : entries.reduce((min, point) => Math.min(min, point.y), Infinity),
      };
    });
}

export type ChartBalancePoint = { x: string; y: number };

export type ChartBalanceBlob = {
  earnedChart: ChartBalancePoint[];
  spentChart: ChartBalancePoint[];
};

// 对齐 models/firefly.ts#getBalanceChart：earned/spent 各自取当前币种的第一条序列。
// x 保持服务端键（字符串），与旧实现一致。
export function buildChartBalanceBlob(balances: unknown, currencyCode: string): ChartBalanceBlob {
  const list = arrayOf(balances).filter(isRecord);
  const pointsOf = (label: 'earned' | 'spent'): ChartBalancePoint[] => {
    const series = list.find((item) => item.currencyCode === currencyCode && item.label === label);
    const entries = series !== undefined && isRecord(series.entries) ? series.entries : {};
    return Object.keys(entries).map((key) => ({ x: key, y: toNumber(entries[key]) }));
  };
  return { earnedChart: pointsOf('earned'), spentChart: pointsOf('spent') };
}

export type BillLike = {
  id?: string;
  attributes?: {
    name?: string;
    active?: boolean;
    nextExpectedMatch?: string | null;
    paidDates?: unknown[];
    currentPaidAmount?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type BillSplit = { billId?: string; amount?: string | number };

const paidDatesLength = (bill: BillLike): number => (
  Array.isArray(bill.attributes?.paidDates) ? bill.attributes.paidDates.length : 0
);

const expectedTime = (value: unknown): number => {
  if (typeof value !== 'string') {
    return 0;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
};

// 对齐 models/bills.ts#getBills：
// - 只保留 active；
// - currentPaidAmount 来自区间内带 billId 的 split 金额之和（调用方用本地交易拼出来）；
// - 先按到期日、再按已付次数排序（已付账单沉底）。
export function buildBillsBlob(bills: BillLike[], splits: BillSplit[]): BillLike[] {
  const paidByBill = new Map<string, number>();
  splits.forEach((split) => {
    if (split.billId === undefined || split.billId === '') {
      return;
    }
    paidByBill.set(split.billId, (paidByBill.get(split.billId) ?? 0) + toNumber(split.amount));
  });

  return [...bills]
    .filter((bill) => bill.attributes?.active === true)
    .map((bill) => ({
      ...bill,
      attributes: {
        ...bill.attributes,
        currentPaidAmount: String(paidByBill.get(bill.id ?? '') ?? 0),
      },
    }))
    .sort((a, b) => (
      expectedTime(a.attributes?.nextExpectedMatch) - expectedTime(b.attributes?.nextExpectedMatch)
    ))
    .sort((a, b) => paidDatesLength(a) - paidDatesLength(b));
}

export type CurrencyLike = {
  id?: string;
  attributes?: {
    enabled?: boolean;
    default?: boolean;
    code?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type CurrenciesBlob = {
  currentCode: string;
  currencies: CurrencyLike[];
};

// 对齐 models/currencies.ts#getCurrencies：只存 enabled 的币种；
// currentCode 优先用当前上下文，缺失时回落到服务端的默认币种。
export function buildCurrenciesBlob(body: unknown, currentCode: string): CurrenciesBlob {
  const list = arrayOf(body).filter(isRecord) as CurrencyLike[];
  const enabled = list.filter((currency) => currency.attributes?.enabled === true);
  const defaultCurrency = list.filter((currency) => currency.attributes?.default === true).pop();
  return {
    currentCode: currentCode || defaultCurrency?.attributes?.code || '',
    currencies: enabled,
  };
}

// 规范形状见 src/db/autocomplete.ts 的 AutocompleteOption：id 必须是字符串，
// 否则 readAutocomplete 会把数字 id 当作缺失（Firefly 的 autocomplete 多数返回数字 id）。
export function buildAutocompleteOptions(body: unknown): AutocompleteOption[] {
  const list = arrayOf(body);
  const options: AutocompleteOption[] = [];
  list.forEach((item) => {
    if (!isRecord(item) || typeof item.name !== 'string' || item.name === '') {
      return;
    }
    const id = item.id === undefined || item.id === null ? '' : String(item.id);
    const type = typeof item.type === 'string' && item.type !== '' ? item.type : undefined;
    options.push({ id, name: item.name, type });
  });
  return options;
}

// ---------------------------------------------------------------------------
// 运行器

// 返回需要刷新的键：低频键（bills / piggy_banks / currencies）与 autocomplete 各自按 TTL
// 判断。缺失、读取失败或超过 TTL 都算到期（读取失败按「需要刷新」处理，
// 让下一轮网络请求有机会修复损坏行）。
export async function lowFrequencyRefreshSet(
  db: Db,
  scopeId: string,
  now: Date = new Date(),
  ttlMs: number = LOW_FREQUENCY_TTL_MS,
): Promise<Set<string>> {
  const entries: Array<{ key: string; ttlMs: number }> = [
    { key: blobKeys.bills(), ttlMs },
    { key: blobKeys.piggyBanks(), ttlMs },
    { key: blobKeys.currencies(), ttlMs },
    ...AUTOCOMPLETE_KINDS.map((kind) => ({
      key: blobKeys.autocomplete(kind),
      ttlMs: AUTOCOMPLETE_TTL_MS,
    })),
  ];
  const due = new Set<string>();

  await Promise.all(entries.map(async (entry) => {
    try {
      const blob = await readBlob<unknown>(db, scopeId, entry.key);
      if (blob === null || isStale(blob.fetchedAt, now, entry.ttlMs)) {
        due.add(entry.key);
      }
    } catch {
      due.add(entry.key);
    }
  }));

  return due;
}

const getBody = async (ctx: BlobSyncContext, url: string): Promise<unknown> => {
  await acquireRequestSlot();
  try {
    const response = await ctx.http.get(url);
    // 所有响应统一归一化为 camelCase：blob 的消费方只认本地模型命名。
    return convertKeysToCamelCase(response?.data);
  } finally {
    releaseRequestSlot();
  }
};

// 本地交易里带 billId 的 split 金额：bills 缓存的 currentPaidAmount 由此拼出。
// 复用上一阶段 pullTransactions 写入的数据，避免再发一次全量交易请求。
async function readLocalBillSplits(
  db: Db,
  scopeId: string,
  range: { start: string; end: string },
): Promise<BillSplit[]> {
  const rows = await db.all<{ payload: string }>(
    `SELECT payload FROM transactions
     WHERE scope_id = ?
       AND substr(occurred_at, 1, 10) >= ?
       AND substr(occurred_at, 1, 10) <= ?`,
    [scopeId, range.start, range.end],
  );

  const splits: BillSplit[] = [];
  rows.forEach((row) => {
    let group: unknown;
    try {
      group = JSON.parse(row.payload);
    } catch {
      // 损坏的本地行跳过：bills 仍可展示，只是金额少算。
      return;
    }
    if (!isRecord(group) || !isRecord(group.attributes)) {
      return;
    }
    const entries = group.attributes.transactions;
    if (!Array.isArray(entries)) {
      return;
    }
    entries.forEach((split) => {
      if (!isRecord(split) || typeof split.billId !== 'string' || split.billId === '') {
        return;
      }
      const amount = typeof split.amount === 'string' || typeof split.amount === 'number'
        ? split.amount
        : undefined;
      splits.push({ billId: split.billId, amount });
    });
  });
  return splits;
}

async function buildPayload(
  db: Db,
  scopeId: string,
  ctx: BlobSyncContext,
  item: BlobPlanItem,
): Promise<unknown> {
  switch (item.kind) {
    case 'accounts': {
      const accounts = await getBody(ctx, accountsUrl(ctx));
      const preference = await getBody(ctx, `${ctx.backendURL}/api/v1/preferences/frontpageAccounts`);
      return buildAccountsBlob(arrayOf(accounts) as AccountLike[], dataOf(preference));
    }
    case 'categories': {
      // 4 个 insight 端点互不依赖，并发发出：串行时任一次慢聚合都会把整轮拖住。
      const [expense, noCategoryExpense, income, noCategoryIncome] = await Promise.all([
        getBody(ctx, insightUrl(ctx, 'expense/category')),
        getBody(ctx, insightUrl(ctx, 'expense/no-category')),
        getBody(ctx, insightUrl(ctx, 'income/category')),
        getBody(ctx, insightUrl(ctx, 'income/no-category')),
      ]);
      return buildCategoriesBlob(
        arrayOf(expense) as InsightCategoryInput[],
        arrayOf(noCategoryExpense) as InsightCategoryInput[],
        arrayOf(income) as InsightCategoryInput[],
        arrayOf(noCategoryIncome) as InsightCategoryInput[],
        ctx.currencyCode,
        ctx.range.start,
        ctx.range.end,
      );
    }
    case 'budgets': {
      const budgets = await getBody(ctx, budgetsUrl(ctx));
      const limits = await getBody(ctx, budgetLimitsUrl(ctx));
      return buildBudgetsBlob(
        arrayOf(budgets) as BudgetLike[],
        arrayOf(limits) as BudgetLimitLike[],
        ctx.currencyCode,
      );
    }
    case 'summary': {
      const summary = await getBody(ctx, summaryUrl(ctx));
      return extractSummary(isRecord(summary) ? summary : {}, ctx.currencyCode);
    }
    case 'chartAccounts': {
      const charts = await getBody(ctx, chartAccountsUrl(ctx));
      return buildChartAccountsBlob(
        arrayOf(charts) as ChartAccountLike[],
        ctx.range,
        ctx.currencyCode,
        ctx.selectedBrandStyle,
      );
    }
    case 'chartBalance': {
      const accounts = await getBody(ctx, chartBalanceAccountsUrl(ctx));
      const accountIds = (arrayOf(accounts) as Array<{ id?: string | number }>)
        .map((account) => account.id)
        .filter((id): id is string | number => id !== undefined);

      // 版本过低或没有资产账户时旧实现直接留空，不发 chart 请求。
      if (semver.valid(ctx.apiVersion) === null
        || !semver.gte(ctx.apiVersion, '2.0.9')
        || accountIds.length === 0) {
        return { earnedChart: [], spentChart: [] };
      }

      const balances = await getBody(
        ctx,
        buildBalanceChartUrl(ctx.backendURL, ctx.range, ctx.apiVersion, accountIds),
      );
      return buildChartBalanceBlob(balances, ctx.currencyCode);
    }
    case 'autocomplete': {
      if (item.autocompleteKind === undefined) {
        throw new Error('autocomplete plan item is missing kind');
      }
      const body = await getBody(ctx, autocompleteUrl(ctx, item.autocompleteKind));
      return buildAutocompleteOptions(body);
    }
    case 'bills': {
      const bills = await getBody(ctx, billsUrl(ctx));
      const splits = await readLocalBillSplits(db, scopeId, ctx.range);
      return buildBillsBlob(arrayOf(bills) as BillLike[], splits);
    }
    case 'piggyBanks': {
      const piggyBanks = await getBody(ctx, piggyBanksUrl(ctx));
      return arrayOf(piggyBanks);
    }
    case 'currencies': {
      const currencies = await getBody(ctx, currenciesUrl(ctx));
      return buildCurrenciesBlob(currencies, ctx.currencyCode);
    }
    default:
      throw new Error('unknown blob kind');
  }
}

// 固定并发：最多 limit 个计划项同时处理；单条计划项内部的请求并发由 getBody 的
// 全局信号量统一约束（MAX_IN_FLIGHT_REQUESTS），因此请求级上限可预期。
async function runBounded<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

// 拉取并写入当前区间/币种/过滤开关下的全部 blob。单个键失败只跳过该键（旧缓存保留），
// 返回成功写入的键数。全部结束后按 spec §7.3 的淘汰策略修剪：
// 当前区间 + 最近 3 个区间组合保留，autocomplete / 低频键永不修剪。
export async function pullBlobs(db: Db, scopeId: string, ctx: BlobSyncContext): Promise<number> {
  const staleLowFrequency = await lowFrequencyRefreshSet(db, scopeId);
  const plan = planBlobRefresh(ctx, { staleLowFrequency });
  const written: string[] = [];

  await runBounded(plan, FETCH_CONCURRENCY, async (item) => {
    try {
      const payload = await buildPayload(db, scopeId, ctx, item);
      await writeBlob(db, scopeId, item.key, payload);
      written.push(item.key);
    } catch {
      // 单键失败不阻断其他键，也不记录细节：错误信息可能带 URL 或账户数据。
    }
  });

  // 本轮一个键都没写成（例如令牌失效导致所有端点失败）：保留全部旧缓存，不做任何修剪。
  if (written.length === 0) {
    return 0;
  }

  // 修剪基于「库里已有的键 + 本轮计划键」：失败键若在同区间已有旧快照，仍会被保留。
  const rows = await db.all<{ key: string }>('SELECT key FROM blobs WHERE scope_id = ?', [scopeId]);
  const allKeys = new Set<string>(rows.map((row) => row.key));
  plan.forEach((item) => allKeys.add(item.key));

  const currentRange = `${ctx.range.start}:${ctx.range.end}`;
  const doomed = new Set(selectKeysToPrune([...allKeys], currentRange, KEEP_RANGE_COMBINATIONS));
  const keepKeys = [...allKeys].filter((key) => !doomed.has(key));
  await pruneBlobs(db, scopeId, keepKeys);

  return written.length;
}
