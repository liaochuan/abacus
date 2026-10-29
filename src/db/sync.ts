import type { AxiosInstance } from 'axios';

import type { Db } from './types';
import type { OutboxItem } from './outbox';
import {
  MAX_OUTBOX_ATTEMPTS,
  listOutbox,
  markOutboxFailed,
  recordOutboxAttempt,
} from './outbox';
import { setMeta } from './repository';
import { pullBlobs } from './syncBlobs';
import { classifySyncError } from './syncErrors';
import { pullTransactions } from './syncPull';
import { LocalWriteError, pushCreate, pushUpdate } from './syncPush';

// 同步编排：一次 runSync = 推送待发 outbox → 拉取交易 → 拉取 blob → 推进 last_synced_at。
// 顺序固定（spec §7.6「先 push，后 pull」），因为推送会绑定服务端 id，
// 随后拉取才能看到刚写入的那笔并避免把它当成「本地有、服务端没有」而对账删除。
//
// 本文件不直接发 HTTP、不打日志：错误信息只有固定短句与错误分类，
// 不含 payload、token、账户名或备注。

// SyncContext 是 syncPush / syncPull / syncBlobs 三个窄上下文的超集，
// 因此可以结构化赋值给它们（各文件只声明自己用到的字段）。
// 后端地址、token、区间、币种等由调度层（03-T8 的 syncState）从 redux 组装。
//
// 契约（重要）：`http` 必须在**每次请求时**读取 `ctx.accessToken`（例如用闭包持有
// 当前活动上下文的 axios 拦截器注入 Authorization），不能在组装上下文时把 token 固化进
// header/defaults。`withAuthRetry` 只替换 `accessToken`（浅拷贝出新上下文）并整轮重跑，
// 它不重建 axios 实例；如果 http 读的是旧 token，刷新后的重试会再次 401 并直接
// 变成 AuthExpiredError。
export type SyncContext = {
  backendURL: string;
  accessToken: string;
  http: AxiosInstance;
  range: { start: string; end: string };
  currencyCode: string;
  displayAllAccounts: boolean;
  apiVersion: string;
  refreshToken(): Promise<string>;
  // 图表品牌色只是展示细节，属于可选字段（syncBlobs 缺省时用默认橙色）。
  selectedBrandStyle?: string;
};

export type SyncResult = {
  /** outbox 项成功处理数（含 duplicate 与 conflict）——冲突项也已被推送。 */
  pushed: number;
  /** 本轮取回的交易组数（取回量，不是写入行数）。 */
  pulled: number;
  /** 本轮因服务端已删除而清理掉的本地行数。 */
  deleted: number;
  /** 推送结果里出现冲突的次数（是 pushed 的子集）。 */
  conflicts: number;
  /** 本轮因不可重试错误或重试次数耗尽而转入 failed 的 outbox 项数。 */
  failed: number;
};

// 认证彻底失效：refresh 之后仍然 401/403，或 refresh 本身被服务端拒绝。
// 消息是固定的、无内容的短句——它会被日志与状态层展示，不能带 token 或账户信息。
export class AuthExpiredError extends Error {
  constructor() {
    super('sync requires re-authentication');
    this.name = 'AuthExpiredError';
  }
}

// meta 键：last_synced_at 是「最后一次完整成功」的基准（UI 与连接告警都用它），
// last_sync_error 是最近一次失败的错误分类（无内容，可直接展示）。
const META_LAST_SYNCED_AT = 'last_synced_at';
const META_LAST_SYNC_ERROR = 'last_sync_error';
const META_CONNECTION_ALERT_LEVEL = 'connection_alert_level';
const META_CONNECTION_ALERT_ACKNOWLEDGED_AT = 'connection_alert_acknowledged_at';

// 失败分类 → meta.last_sync_error 的取值。全部是固定的枚举串，不含任何业务数据。
function syncErrorLabel(error: unknown): string {
  if (error instanceof AuthExpiredError) {
    return 'auth';
  }
  return classifySyncError(error);
}

// 在认证失败时刷新一次 token 并重试一次。
// - 只有 classifySyncError === 'auth'（401/403）才触发刷新；
// - 刷新成功后用浅拷贝替换 accessToken，重试时把新上下文交给 fn，原始 ctx 不被修改；
// - 重试仍认证失败 → AuthExpiredError（由调用方停止自动同步并要求重新登录，不删除凭证）；
// - 刷新本身失败（spec §7.6 Token 步骤 3/4）：可重试的 network / server 原样抛出，
//   让调用方按「离线、下轮再试」处理；其余（认证被拒、invalid_grant 之类的 4xx）
//   一律视为需要重新登录 → AuthExpiredError。
export async function withAuthRetry<T>(
  ctx: SyncContext,
  fn: (active: SyncContext) => Promise<T>,
): Promise<T> {
  try {
    return await fn(ctx);
  } catch (error) {
    if (classifySyncError(error) !== 'auth') {
      throw error;
    }
  }

  let accessToken: string;
  try {
    accessToken = await ctx.refreshToken();
  } catch (error) {
    const kind = classifySyncError(error);
    if (kind === 'network' || kind === 'server') {
      throw error;
    }
    throw new AuthExpiredError();
  }

  const refreshed: SyncContext = { ...ctx, accessToken };
  try {
    return await fn(refreshed);
  } catch (error) {
    if (classifySyncError(error) === 'auth') {
      throw new AuthExpiredError();
    }
    throw error;
  }
}

export function mergeSyncResult(a: SyncResult, b: SyncResult): SyncResult {
  return {
    pushed: a.pushed + b.pushed,
    pulled: a.pulled + b.pulled,
    deleted: a.deleted + b.deleted,
    conflicts: a.conflicts + b.conflicts,
    failed: a.failed + b.failed,
  };
}

type PushTally = {
  pushed: number;
  conflicts: number;
  failed: number;
};

const noPush = (): PushTally => ({ pushed: 0, conflicts: 0, failed: 0 });

// 处理单条 outbox 项，返回这一项的计数增量。失败按下面的规则处置，
// 不向上抛（auth 除外），因此一条坏数据不会阻断队列。
async function pushOne(
  db: Db,
  scopeId: string,
  ctx: SyncContext,
  item: OutboxItem,
): Promise<PushTally> {
  try {
    if (item.op === 'create') {
      const outcome = await pushCreate(db, scopeId, ctx, item);
      return outcome === 'failed'
        ? { ...noPush(), failed: 1 }
        : { ...noPush(), pushed: 1 };
    }

    const outcome = await pushUpdate(db, scopeId, ctx, item);
    if (outcome === 'failed') {
      return { ...noPush(), failed: 1 };
    }
    // 冲突项仍然完成了 PUT（本地覆盖服务端，spec §7.6），所以计入 pushed，
    // 同时单独累加 conflicts 供 UI 提示。
    return {
      ...noPush(),
      pushed: 1,
      conflicts: outcome === 'conflict' ? 1 : 0,
    };
  } catch (error) {
    // 服务端已接受、只有本地写库失败：outbox 行必须留在 pending 让下一轮对账，
    // 绝不能标 failed（否则交易在服务端成孤儿，用户重录还会造出重复）。
    // attempts 仍累加供状态条展示，本轮计入 failed；不套用 MAX_OUTBOX_ATTEMPTS。
    if (error instanceof LocalWriteError) {
      await recordOutboxAttempt(db, scopeId, item.id, 'local-write');
      return { ...noPush(), failed: 1 };
    }
    const kind = classifySyncError(error);
    if (kind === 'auth') {
      throw error;
    }
    if (kind === 'network' || kind === 'server') {
      if (item.attempts + 1 >= MAX_OUTBOX_ATTEMPTS) {
        await markOutboxFailed(db, item.id, kind);
        return { ...noPush(), failed: 1 };
      }
      await recordOutboxAttempt(db, scopeId, item.id, kind);
      return noPush();
    }
    await markOutboxFailed(db, item.id, kind);
    return { ...noPush(), failed: 1 };
  }
}

// 推送阶段：按 listOutbox 返回的顺序（created_at ASC, id ASC）逐条处理。
// 单条失败不阻断队列——一条坏数据不能把后面所有交易卡在本地。
// 错误处置（spec §7.5 失败分类表）：
// - auth：向上抛出，交给 withAuthRetry 刷新 token 后整轮重跑（标记 failed 会让刷新成功也不再重试）；
// - network / server：可重试，attempts += 1 并保持 pending；累计到上限则转 failed；
// - LocalWriteError（2xx 之后的本地写库失败）：attempts += 1、保持 pending、计入 failed，
//   永不标 failed，让下一轮对账接住服务端那笔交易；
// - 其余（invalid / gone / other 等）：转 failed，计入 failed，等用户在「需处理」里处理。
// pushCreate / pushUpdate 自己识别出的不可重试错误（409/422、404 等）会直接标记 failed 并返回
// 'failed'，这里只做计数，不重复落库。
async function pushPending(
  db: Db,
  scopeId: string,
  ctx: SyncContext,
): Promise<PushTally> {
  const tally = noPush();
  const items = await listOutbox(db, scopeId, 'pending');

  for (let i = 0; i < items.length; i += 1) {
    // 必须串行：同一 entity 的 create 会先换 id、再删 outbox 行，并发处理会互相踩。
    // 认证错误（classifySyncError === 'auth'）由 pushOne 原样上抛，这里不捕获：
    // 让它逃出 runSync 交给 withAuthRetry 刷新 token 后整轮重跑。重跑是安全的——
    // 推送是幂等的：create 在 POST 前先按组标题对账，已推送成功的 outbox 行也已被删除。
    // eslint-disable-next-line no-await-in-loop
    const delta = await pushOne(db, scopeId, ctx, items[i]);
    tally.pushed += delta.pushed;
    tally.conflicts += delta.conflicts;
    tally.failed += delta.failed;
  }

  return tally;
}

// 本轮 pull 成功：推进 last_synced_at，并（仅在没有遗留问题的时候）清空连接告警。
// 有 failed / conflicts 时仍推进 last_synced_at——拉取确实成功了，UI 的「最后同步」应更新——
// 但保留 connection_alert_level / connection_alert_acknowledged_at：还有待处理项时清掉告警
// 会让用户以为问题已消失。清空与推进同事务，避免出现中间态。
// 任一语句失败整体回滚，调用方看到的是抛错，last_synced_at 保持旧值。
async function markSynced(
  db: Db,
  scopeId: string,
  now: Date,
  options: { keepAlerts: boolean },
): Promise<void> {
  await db.tx(async () => {
    await setMeta(db, scopeId, META_LAST_SYNCED_AT, now.toISOString());
    await setMeta(db, scopeId, META_LAST_SYNC_ERROR, null);
    if (options.keepAlerts) {
      return;
    }
    // 干净同步必须把已确认档位归零（删除即读作 0），不能只清确认时间：
    // 用户确认过 7 档后再遇到新的 3 天断网，比较 3 > 7 会一直为假，
    // 直到第 7 天才提醒。档位与确认时间同事务清空，避免中间态。
    await setMeta(db, scopeId, META_CONNECTION_ALERT_LEVEL, null);
    await setMeta(db, scopeId, META_CONNECTION_ALERT_ACKNOWLEDGED_AT, null);
  });
}

// 记录最近一次失败的错误分类。写库失败不覆盖原始错误（否则调用方看到的是
// 「disk I/O error」而不是真正的网络/认证失败）。
async function recordSyncFailure(db: Db, scopeId: string, error: unknown): Promise<void> {
  try {
    await setMeta(db, scopeId, META_LAST_SYNC_ERROR, syncErrorLabel(error));
  } catch {
    // 忽略：meta 写不进去时仍要把原始错误抛给调用方。
  }
}

// 一轮同步的实际流水线。被 withAuthRetry 包裹，因此 token 过期后会整轮重跑：
// 已经推送成功的 outbox 行已被删除，重跑是幂等的 no-op。
async function runPipeline(
  db: Db,
  scopeId: string,
  ctx: SyncContext,
  full: boolean,
): Promise<SyncResult> {
  const result: SyncResult = {
    pushed: 0, pulled: 0, deleted: 0, conflicts: 0, failed: 0,
  };

  const tally = await pushPending(db, scopeId, ctx);
  result.pushed = tally.pushed;
  result.conflicts = tally.conflicts;
  result.failed = tally.failed;

  // push 阶段即使有单项失败也算「完成」：仍然拉取，让用户看到服务端的最新状态。
  // 只有 push 抛错（auth / 无法落库）才会走到异常分支，不进入 pull。
  const pulled = await pullTransactions(db, scopeId, ctx, full);
  result.pulled = pulled.pulled;
  result.deleted = pulled.deleted;

  if (!pulled.complete) {
    // 不完整 = 没有做删除对账，本地可能缺少服务端数据。
    // 已拉到的数据已经落库，但 last_synced_at 不能推进（spec §7.6 步骤 5），
    // 也不刷新 blob（避免基于半份数据重建图表）。
    await setMeta(db, scopeId, META_LAST_SYNC_ERROR, 'incomplete');
    return result;
  }

  // blob 刷新只在交易完整拉取后执行：bills 的 currentPaidAmount 依赖本轮交易数据。
  // 单键失败在 pullBlobs 内部吞掉；只有写库级失败会抛到这里，同样不推进 last_synced_at。
  await pullBlobs(db, scopeId, ctx);

  // 有 failed 或 conflicts 时告警键保持原样（见 markSynced），只有完全干净的一轮才清空。
  await markSynced(db, scopeId, new Date(), {
    keepAlerts: result.failed > 0 || result.conflicts > 0,
  });
  return result;
}

// 同步入口。opts.full 控制拉取窗口（90 天 / 365 天），透传给 pullTransactions。
// 失败语义：
// - push 的单项 network/server 失败被内部消化（行保持 pending，下轮退避重试）；
// - push 的认证失败会先刷新 token 重试，仍失败抛 AuthExpiredError；
// - pull 抛错或拉取不完整时不推进 last_synced_at，并把错误分类写入 meta.last_sync_error；
//   pull 抛错会原样向上抛，让调度层进入 error / offline 状态。
export async function runSync(
  db: Db,
  scopeId: string,
  ctx: SyncContext,
  opts: { full?: boolean } = {},
): Promise<SyncResult> {
  const full = opts.full === true;
  try {
    return await withAuthRetry(ctx, (active) => runPipeline(db, scopeId, active, full));
  } catch (error) {
    await recordSyncFailure(db, scopeId, error);
    throw error;
  }
}
