import type { AxiosInstance } from 'axios';
import type { TransactionType } from '../models/transactions';
import { convertKeysToCamelCase } from '../lib/case';
import { reconcileDeletions, upsertServerTransactions } from './repository';
import { computePullWindow } from './syncWindows';
import type { Db } from './types';

// Pull：把服务端窗口内的交易组拉回本地，并在「完整拉取成功」后做删除对账。
// 本文件不处理 token、不做重试与退避（由调用方 runSync 的 withAuthRetry / 调度层负责），
// 也刻意不打任何日志：错误信息里只有固定的英文短句，不含 payload、账户名或备注。

// 与 SyncPushContext 同样的窄接口：完整 SyncContext（src/db/sync.ts）是它的超集，
// 因此 runSync 组装出的上下文可以结构化赋值进来，本文件也不必反向依赖 sync.ts。
export type SyncPullContext = {
  backendURL: string;
  http: AxiosInstance;
};

export type PullWindow = {
  start: string;
  end: string;
};

// Firefly 单页上限（官方默认 50）。取上限以减少翻页次数。
const PAGE_LIMIT = 50;

// 搜索 URL：query 里的空格编码为 %20、冒号编码为 %3A。
// 日期窗口用纯日期（YYYY-MM-DD），Firefly 的 date_after / date_before 按交易日期过滤。
export function buildSearchUrl(
  backendURL: string,
  window: PullWindow,
  page: number,
  limit: number,
): string {
  const query = `date_after:${window.start} date_before:${window.end}`;
  return `${backendURL}/api/v1/search/transactions?limit=${limit}&page=${page}&query=${encodeURIComponent(query)}`;
}

// 只声明本文件读取的字段：data 是交易组数组，meta.pagination 给总页数。
// Firefly 原始响应是 snake_case，但 ctx.http 的拦截器是否做过转换不属于本层能假设的事，
// 因此 totalPages / total_pages 两种写法都认。
type SearchBody = {
  data?: unknown;
  meta?: {
    pagination?: {
      totalPages?: unknown;
      total_pages?: unknown;
    };
  };
};

// 服务端没给出可用总页数时返回 null —— 调用方据此把本轮判为「不完整」，
// 不能拿 1 当兜底：那会在还有第 2 页时停下来，并把第 2 页之后的一切当成已删除。
function totalPagesOf(body: SearchBody | undefined): number | null {
  const raw = body?.meta?.pagination?.totalPages ?? body?.meta?.pagination?.total_pages;
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
}

// 翻页上限：50 × 200 = 10000 组。超出这个规模的窗口已不符合「90 天 / 365 天」的假设，
// 与其无限请求，不如停下来标记不完整（不对账），交给下一轮。
const MAX_PAGES = 200;

type FetchedPages = {
  items: TransactionType[];
  // false 表示这次响应链不足以支撑「本地有、服务端没有 = 已删除」的结论：
  // 出现过早的空页、存在无法识别 id 的组、超过翻页上限，或始终没有总页数元数据。
  complete: boolean;
};

async function fetchTransactionPages(
  ctx: SyncPullContext,
  window: PullWindow,
): Promise<FetchedPages> {
  const items: TransactionType[] = [];
  let complete = true;
  // null = 本轮还没有从任何一页拿到可用总页数。
  let totalPages: number | null = null;
  let page = 1;

  for (;;) {
    if (page > MAX_PAGES) {
      complete = false;
      break;
    }

    const response = await ctx.http.get(
      buildSearchUrl(ctx.backendURL, window, page, PAGE_LIMIT),
    );
    const body = response?.data as SearchBody | undefined;
    const entries = body?.data;
    if (!Array.isArray(entries)) {
      // 结构异常：响应不可信。抛给 runSync 计入失败并走退避，
      // 绝不在无法确认的数据上做删除对账。
      throw new Error('transaction search response missing data');
    }

    // 总页数每页都可能变（分页期间数据在变）。取见过的最大值：
    // 服务端一度声称有 3 页，就必须把第 3 页看完，不能因为它后来缩成 2 页就提前收工。
    const known = totalPagesOf(body);
    if (known !== null) {
      totalPages = totalPages === null ? known : Math.max(totalPages, known);
    }

    if (entries.length === 0) {
      // 空页结束本轮。只有「第 1 页就空、且服务端说总共 1 页」才是明确的
      // 「窗口内没有交易」。其余空页都可能是分页期间数据被删、行被挤回已经读过的页
      // （漏读 → 误判删除），因此本轮不算完整。
      complete = complete && page === 1 && totalPages === 1;
      break;
    }

    for (let i = 0; i < entries.length; i += 1) {
      // Firefly 原始组为 snake_case，本地模型与 SQL 全按 camelCase 读写。
      const group = convertKeysToCamelCase(entries[i]) as TransactionType;
      if (group && typeof group.id === 'string' && group.id !== '') {
        items.push(group);
      } else {
        // 没有 id 的组既无法落库，也说明响应不可信 → 整轮不做删除对账。
        complete = false;
      }
    }

    if (totalPages !== null && page >= totalPages) {
      // 已取到服务端声称的最后一页。
      break;
    }

    page += 1;
  }

  if (totalPages === null) {
    // 整个分页过程都没拿到总页数：无法证明已经看到末尾，不做删除对账。
    complete = false;
  }

  return { items, complete };
}

// 拉完窗口内的全部交易组（已归一化为 camelCase）。
// 中途任何一页失败都直接抛出，不返回半份结果。
export async function fetchAllTransactions(
  ctx: SyncPullContext,
  window: PullWindow,
): Promise<TransactionType[]> {
  const { items } = await fetchTransactionPages(ctx, window);
  return items;
}

export type PullResult = {
  /**
   * 本次拉到的交易组数量。
   * 注意：这是「取回量」而不是「写入行数」——`upsertServerTransactions` 会跳过 `dirty = 1`
   * 的本地行（本地优先），因此 pulled 可能大于实际被覆盖的行数。
   */
  pulled: number;
  /** 本次因服务端已删除而清理掉的本地行数。 */
  deleted: number;
  /**
   * 本轮是否为完整拉取。false 表示没有做删除对账：提前空页、缺 id 的组、
   * 超过翻页上限，或响应始终没有可用的总页数。此时不抛错（已拉到的数据仍然有效，
   * 已经 upsert），但调用方（runSync）应把它显式呈现出来。
   */
  complete: boolean;
};

// 拉取窗口内的交易并落库：
// 1. 按 full 计算窗口（90 天 / 365 天）；
// 2. 分页取完 → upsertServerTransactions（内部跳过 dirty = 1 的本地改动）；
// 3. 只有在**完整**拉取成功后才做删除对账——网络中断、某页失败、或提前遇到空页时
//    都不能把「没拉到」当成「服务端已删除」，否则一次断网就会误删本地记录。
export async function pullTransactions(
  db: Db,
  scopeId: string,
  ctx: SyncPullContext,
  full: boolean,
): Promise<PullResult> {
  const window = computePullWindow(new Date(), full);
  const { items, complete } = await fetchTransactionPages(ctx, window);

  await upsertServerTransactions(db, scopeId, items);

  if (!complete) {
    return { pulled: items.length, deleted: 0, complete };
  }

  // 删除对账的边界：本地窗口之外的行（早于 window.start 或晚于 window.end）本次根本没被
  // 拉取，必须显式放进 seen 集合，否则 reconcileDeletions 会把它们一律当成服务端已删除。
  // 两侧都用闭区间（<= / >=）：边界当天的行宁可不参与对账，也不能被误删。
  // occurred_at 可能是纯日期，也可能带时间/时区，取前 10 位（日期部分）比较，
  // 避免跨边界时字符串比较失真。
  const outsideWindow = await db.all<{ id: string }>(
    `SELECT id FROM transactions
     WHERE scope_id = ?
       AND (substr(occurred_at, 1, 10) <= ? OR substr(occurred_at, 1, 10) >= ?)`,
    [scopeId, window.start, window.end],
  );

  const seenIds = new Set<string>();
  for (let i = 0; i < items.length; i += 1) {
    seenIds.add(items[i].id);
  }
  for (let i = 0; i < outsideWindow.length; i += 1) {
    seenIds.add(outsideWindow[i].id);
  }

  // 局部失败（写 notices 或删行）由 reconcileDeletions 的事务整体回滚并向上抛。
  const deleted = await reconcileDeletions(db, scopeId, seenIds);
  return { pulled: items.length, deleted, complete };
}
