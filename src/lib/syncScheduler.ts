/* eslint-disable @typescript-eslint/no-use-before-define */
// 调度器里的 requestSync 与定时器/补跑辅助函数互相引用（都是函数声明，存在提升），
// 统一关闭该规则，避免为了调用顺序做无意义的函数重排。

import type { Db } from '../db/types';
import { getDb } from '../db/instance';
import { getMeta } from '../db/repository';
import { getCurrentScope } from '../db/scope';
import { AuthExpiredError, runSync } from '../db/sync';
import { pullBlobs } from '../db/syncBlobs';
import { classifySyncError } from '../db/syncErrors';
import {
  emitSyncChanged,
  isSyncRunning,
  nextSyncDelay,
  runExclusively,
  setSyncState,
} from '../db/syncState';
import { buildSyncContext } from './syncContext';
import { isOnline } from './network';
import { isStale } from '../db/staleness';

// 同步调度层：所有触发点（启动、前台、网络恢复、定时器、手动、保存后）都只调 requestSync；
// 只换展示维度（区间 / 币种 / 账户过滤）时调 requestBlobSync，只补缓存、不跑整轮。
// 这里负责「什么时候能跑」与「跑完把状态写成什么」，不负责业务流水线（在 db/sync.ts）。
//
// 三条硬约束：
// 1. 永不阻塞 UI：调用方一律 `requestSync(...).catch(() => {})`；
// 2. 单飞：同一时刻只允许一轮（runExclusively），并发触发直接跳过；
// 3. 状态里只放固定枚举/短句与计数，绝不放 payload、token 或账户名。

export type SyncReason = 'manual' | 'startup' | 'online' | 'foreground' | 'timer' | 'after-save' | 'deferred';

// requestSync 的可选行为：
// - pushOnly：只推 outbox（保存交易后的第一段）；
// - quiet：后台补跑，不把顶栏切成 syncing，也不上报阶段。
export type RequestSyncOptions = {
  pushOnly?: boolean;
  quiet?: boolean;
};

type QueuedRequest = { reason: SyncReason; options: RequestSyncOptions };

type Snapshot = {
  lastSyncedAt: string | null;
  pending: number;
  problems: number;
};

const EMPTY_SNAPSHOT: Snapshot = { lastSyncedAt: null, pending: 0, problems: 0 };

// meta 键与 db/sync.ts 保持一致（那边不导出，避免为了一个字符串把两个模块耦合起来）。
const META_LAST_SYNCED_AT = 'last_synced_at';

// 排期读库失败（库未就绪）时的兜底间隔；正常空闲会直接停表。
const DB_READ_RETRY_INTERVAL_MS = 600_000;

// 前台恢复的最小同步间隔：距上次成功同步不足 5 分钟就不再发请求。
// 冷启动与下拉刷新不受这个间隔限制。
export const SYNC_MIN_INTERVAL_MS = 5 * 60_000;

// 保存交易后的重活（pull + blob）延后多久执行：连续保存只跑最后一次，且不阻塞交易上传。
export const AFTER_SAVE_DEFER_MS = 3_000;

// 账号在同步中途被切换时，本轮作废但新 scope 必须补跑一次；只记一个标记，
// 当前轮结束后由 requestSync 消费（见末尾）。
let pendingRequest: QueuedRequest | null = null;

// 当前正在跑的那一轮属于哪个 scope。用于识别「同步进行中切号」的触发；
// 同账号的普通重复触发仍丢弃，但 manual / deferred / push-only 会排队补跑（见 requestSync）。
let runningScopeId: string | null = null;

// 保存交易后安排的补跑句柄：每次保存都重置计时，避免每笔交易都跑一轮整同步。
let deferredHandle: ReturnType<typeof setTimeout> | null = null;

// 只补 blob 的请求在上一轮结束后补跑一次。与 pendingRequest 分开记：
// 它不跑 push / pull 交易，只是把新维度（区间、币种、账户过滤）对应的缓存拉下来。
let pendingBlobSync = false;

// 状态条要的计数：pending 是待推送的 outbox 行数，problems 是「需处理」项
// （failed 的 outbox 行 + 未确认的 notices）。两条都是带 scope 过滤的聚合查询，
// 走 (scope_id, status) / (scope_id, acknowledged_at) 索引，不做全表扫描。
async function readSnapshot(db: Db, scopeId: string): Promise<Snapshot> {
  const outbox = await db.get<{ pending: number; failed: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
     FROM outbox
     WHERE scope_id = ?`,
    [scopeId],
  );
  const notices = await db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM notices WHERE scope_id = ? AND acknowledged_at IS NULL',
    [scopeId],
  );
  const lastSyncedAt = await getMeta(db, scopeId, META_LAST_SYNCED_AT);

  return {
    lastSyncedAt,
    pending: outbox?.pending ?? 0,
    problems: (outbox?.failed ?? 0) + (notices?.count ?? 0),
  };
}

// 读快照失败（库未就绪、scope 已失效）不能反过来把同步流程打断：退回空计数。
async function readSnapshotSafe(db: Db | null, scopeId: string): Promise<Snapshot> {
  if (db === null || !scopeId) {
    return EMPTY_SNAPSHOT;
  }
  try {
    return await readSnapshot(db, scopeId);
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

// 错误 → 状态条上的固定短句。只暴露分类（auth / network / server ...），
// 不带原始 message——axios 的错误 message 里可能出现 URL（含 backendURL）。
function errorMessage(error: unknown): string {
  if (error instanceof AuthExpiredError) {
    return 'sync requires re-authentication';
  }
  return `sync failed (${classifySyncError(error)})`;
}

/**
 * 请求一轮同步。所有触发点共用这一个入口。
 *
 * - 离线：不建上下文、不发请求，只把状态切到 offline（保留上次成功时间与计数）；
 * - 已有同步在跑：普通重复触发直接返回（不排队）——runExclusively 会复用进行中的 Promise，
 *   触发点不需要等它，重复排队只会让状态条闪；manual / deferred / startup / push-only
 *   例外，它们会记下补跑请求（否则保存的这笔交易会被单飞锁静默吞掉）；
 * - 未登录 / 尚未选定账号：回到 idle，不报错；
 * - 失败：network → offline（下轮再试），其余 → error（固定短句）。
 *
 * options.pushOnly 只推 outbox，不 pull、不刷 blob、不推进 last_synced_at；
 * 该轮正常结束后由 scheduleDeferredFullSync 安排一次延后的整轮补跑。
 * options.quiet 用于后台补跑：不写 syncing 状态，也不上报阶段。
 */
export async function requestSync(
  reason: SyncReason,
  options: RequestSyncOptions = {},
): Promise<void> {
  if (!isOnline()) {
    setSyncState({ kind: 'offline', ...(await readSnapshotForState()) });
    return;
  }
  if (isSyncRunning()) {
    // 同账号的普通重复触发直接丢弃；但切号、主动刷新、deferred 与 push-only
    // 不能被单飞锁吞掉。
    try {
      const db = getDb();
      const currentScope = await getCurrentScope(db);
      if (runningScopeId !== null && currentScope && currentScope !== runningScopeId) {
        // 切号：固定用 startup，保证新 scope 的首轮仍能做 365 天回填。
        queueFollowUp({ reason: 'startup', options: {} });
      } else if (
        reason === 'manual'
        || reason === 'deferred'
        || reason === 'startup'
        || options.pushOnly === true
      ) {
        // 区间/币种变化、下拉刷新、deferred 整轮与 push-only 都必须记下补跑请求：
        // 单飞锁被 requestSync 或 requestBlobSync 持有时，保存的这笔交易不能被静默丢弃。
        queueFollowUp({ reason, options });
      }
    } catch {
      // 读不到当前 scope：保持原有「丢弃重复触发」语义。
    }
    return;
  }

  await runExclusively(async () => {
    let db: Db;
    let scopeId = '';
    let roundFailed = false;

    try {
      db = getDb();
    } catch {
      // 数据库尚未打开（bootstrap degraded）：没有可同步的目标，保持 idle，
      // 不把「库未就绪」显示成同步错误。触发点本身也只在 ready 阶段挂载。
      return;
    }

    // push 是任何一轮的第一阶段；quiet 的后台补跑不改变状态条。
    if (options.quiet !== true) {
      setSyncState({ kind: 'syncing', phase: 'push' });
    }

    try {
      // current_scope 只在这里读一次，后续 buildSyncContext / runSync 都用同一个值；
      // 上下文组装完后再校验一次，账号在 await 期间被切换就放弃本轮。
      scopeId = await getCurrentScope(db);
      runningScopeId = scopeId;
      const ctx = scopeId ? await buildSyncContext(scopeId) : null;
      if (ctx === null) {
        // 没有可同步的账号：可能是这一轮开始后凭据才就绪（首次登录），
        // 若 scope 已变化就补跑一次，不能停在 idle 让新账号一直不同步。
        await noteScopeChange(db, scopeId);
        setSyncState({ kind: 'idle', ...(await readSnapshotSafe(db, scopeId)) });
        return;
      }

      const currentScope = await getCurrentScope(db);
      if (currentScope !== scopeId) {
        // 本轮上下文仍属于旧账号：直接结束，不写入任何 outbox/交易，
        // 状态条按新 scope 的真实计数回到 idle。
        // 新账号的请求在切号时会被单飞锁挡掉，这里补一个标记，本轮结束后替新 scope 补跑。
        queueFollowUp({ reason: 'startup', options: {} });
        setSyncState({ kind: 'idle', ...(await readSnapshotSafe(db, currentScope)) });
        return;
      }

      const before = await readSnapshotSafe(db, scopeId);
      // 首次同步（从没有过成功记录）拉 365 天做一次回填；之后都是 90 天增量窗口。
      // 启动与手动都可以承担回填：冷启动、登录/切号与下拉刷新可能同时到达，
      // 单飞锁只保留其中一个，只看 reason 会让首轮回填随机丢失。
      await runSync(db, scopeId, ctx, {
        full: before.lastSyncedAt === null && (reason === 'startup' || reason === 'manual'),
        pushOnly: options.pushOnly === true,
        // quiet 补跑不改变状态条；其余轮次把阶段变化透出来（push → pull → blobs）。
        onPhase: options.quiet === true
          ? undefined
          : (phase) => setSyncState({ kind: 'syncing', phase }),
      });

      // 同步期间账号被切换：本轮数据属于旧 scope（已落库），但新 scope 还一次都没同步。
      // 它的请求在切号时已被单飞锁挡掉，这里补标记，本轮结束后替新 scope 再跑一次。
      const scopeAfterRun = await getCurrentScope(db);
      if (scopeAfterRun !== scopeId) {
        queueFollowUp({ reason: 'startup', options: {} });
      }

      setSyncState({ kind: 'idle', ...(await readSnapshotSafe(db, scopeId)) });
    } catch (error) {
      roundFailed = true;
      // 失败前如果账号已被切走，同样要替新 scope 补跑一次。
      await noteScopeChange(db, scopeId);
      const snapshot = await readSnapshotSafe(db, scopeId);
      // 分类只算一次：既用于决定 offline / error，也作为 error.reason 供 UI 翻译。
      const kind = classifySyncError(error);
      if (kind === 'network') {
        // 拉取途中断网：语义是「这轮因为离线没跑成」，状态条显示离线而不是报错。
        setSyncState({ kind: 'offline', ...snapshot });
      } else {
        setSyncState({
          kind: 'error',
          reason: error instanceof AuthExpiredError ? 'auth' : kind,
          message: errorMessage(error),
          ...snapshot,
        });
      }
    } finally {
      emitSyncChanged();
      // push-only 轮要确认 outbox 真的清空才安排补跑：pushPending 会把 network / server
      // 失败吞成「保持 pending」，本轮不会抛错。仍有 pending 时交给 ensureTimerIfPending
      // 的 60 秒退避，否则 3 秒后立刻重试会绕过退避并快速耗尽 attempts。
      if (options.pushOnly === true) {
        const after = await readSnapshotSafe(db, scopeId);
        if (!roundFailed && after.pending === 0) {
          scheduleDeferredFullSync();
        }
      }
      // 空闲时定时器会自行停止；同步结束后仍有 outbox 积压时必须重新拉起 60 秒重试，
      // 否则一次失败的推送会一直躺在 pending 里等到下一次人工触发。
      await ensureTimerIfPending();
    }
  });

  runningScopeId = null;

  drainPendingRequests();

  if (pendingBlobSync) {
    pendingBlobSync = false;
    requestBlobSync().catch(() => {});
  }
}

/**
 * 保存交易后的同步入口：先只推送 outbox（一笔 POST 或 PUT），
 * 让服务端尽快拿到这笔交易；pull 与 blob 刷新由 scheduleDeferredFullSync 延后补跑。
 * 保存时正好有同步在跑：本轮结束后先补一次 push-only，再由它安排整轮补跑。
 */
export async function requestAfterSave(): Promise<void> {
  await requestSync('after-save', { pushOnly: true });
}

// 消费上一轮结束时排下的补跑请求。requestSync 与 requestBlobSync 共用同一把单飞锁，
// 两边收尾都要 drain，否则锁被 blob 轮持有时保存的 push-only 会一直搁置。
function drainPendingRequests(): void {
  if (pendingRequest === null) {
    return;
  }
  const next = pendingRequest;
  pendingRequest = null;
  // 不 await：补跑仍走单飞锁，触发点本身不需要等它。
  requestSync(next.reason, next.options).catch(() => {});
}

/**
 * 只补 blob 的一轮：首页区间 / 币种 /「全部账户」变化后，把新维度对应的
 * 账户、图表等缓存拉下来。
 *
 * 与 requestSync 的区别：不 push outbox、不 pull 交易、不推进 last_synced_at，
 * 也不碰 connection_alert——它只解决「换了个维度，本地没有这份缓存」。
 * 走同一个单飞锁，避免与整轮同步并发写同一批 blob；抢不到锁时排队补跑。
 */
export async function requestBlobSync(): Promise<void> {
  if (!isOnline()) {
    // 离线时保持现状：图标本身已经由 NetInfo 显示成离线，不需要再写一次状态。
    return;
  }
  if (isSyncRunning()) {
    // 正有同步在跑：不并发写同一批 blob，等它结束后补一次。
    pendingBlobSync = true;
    return;
  }

  let db: Db;
  try {
    db = getDb();
  } catch {
    return;
  }

  let ranHere = false;
  let scopeId = '';

  await runExclusively(async () => {
    ranHere = true;
    try {
      scopeId = await getCurrentScope(db);
      if (!scopeId) {
        return;
      }
      const ctx = await buildSyncContext(scopeId);
      if (ctx === null) {
        return;
      }
      runningScopeId = scopeId;
      setSyncState({ kind: 'syncing', phase: 'pull' });
      await pullBlobs(db, scopeId, ctx);
      setSyncState({ kind: 'idle', ...(await readSnapshotSafe(db, scopeId)) });
    } catch (error) {
      const kind = classifySyncError(error);
      const snapshot = await readSnapshotSafe(db, scopeId);
      if (kind === 'network') {
        setSyncState({ kind: 'offline', ...snapshot });
      } else {
        setSyncState({
          kind: 'error',
          reason: error instanceof AuthExpiredError ? 'auth' : kind,
          message: errorMessage(error),
          ...snapshot,
        });
      }
    } finally {
      emitSyncChanged();
      runningScopeId = null;
    }
  });

  if (!ranHere) {
    // 没抢到锁：说明正有别的同步在跑，等它结束后补一次。
    pendingBlobSync = true;
    return;
  }

  // blob 轮与整轮共用一把单飞锁：锁被它持有时排下的 push-only / manual 也要在这里消费，
  // 否则保存的这笔交易要等到下一次 startup/manual 才会推送。
  drainPendingRequests();

  if (pendingBlobSync) {
    pendingBlobSync = false;
    requestBlobSync().catch(() => {});
  }
}

// startup/manual 能承担首次 365 天回填；startup 优先级最高，不能被弱 reason 覆盖。
function queueFollowUp(request: QueuedRequest): void {
  if (request.reason === 'startup') {
    pendingRequest = { reason: 'startup', options: {} };
    return;
  }
  if (pendingRequest === null) {
    pendingRequest = request;
  }
}

function clearDeferredHandle(): void {
  if (deferredHandle !== null) {
    clearTimeout(deferredHandle);
    deferredHandle = null;
  }
}

// 保存交易后延后跑一整轮（pull + blobs）。连续保存只保留最后一次：每次调用都重置计时，
// 避免每保存一笔就跑一轮整同步。补跑用 quiet，不重新把顶栏切成 syncing。
function scheduleDeferredFullSync(): void {
  if (!isOnline()) {
    return;
  }
  clearDeferredHandle();
  deferredHandle = setTimeout(() => {
    deferredHandle = null;
    resolveDeferredReason()
      .then((reason) => requestSync(reason, { quiet: true }))
      .catch(() => {});
  }, AFTER_SAVE_DEFER_MS);
}

// 从来没成功同步过时按 startup 跑，保证首轮仍是 365 天回填；
// 读不到状态就按 deferred（下一次 startup / manual 仍会兜底）。
async function resolveDeferredReason(): Promise<SyncReason> {
  try {
    const db = getDb();
    const scopeId = await getCurrentScope(db);
    if (scopeId && (await getMeta(db, scopeId, META_LAST_SYNCED_AT)) === null) {
      return 'startup';
    }
  } catch {
    // 忽略：按 deferred 处理。
  }
  return 'deferred';
}

async function ensureTimerIfPending(): Promise<void> {
  try {
    const db = getDb();
    const scopeId = await getCurrentScope(db);
    if (!scopeId) {
      return;
    }
    const snapshot = await readSnapshot(db, scopeId);
    if (snapshot.pending > 0) {
      ensureSyncTimer();
    }
  } catch {
    // 状态读不到时不做处理：下一次触发仍会走正常同步流程。
  }
}

// 本轮结束前再确认一次 scope：账号被切走时本轮作废，但新 scope 需要补跑。
async function noteScopeChange(db: Db, scopeId: string): Promise<void> {
  try {
    const currentScope = await getCurrentScope(db);
    if (currentScope && currentScope !== scopeId) {
      queueFollowUp({ reason: 'startup', options: {} });
    }
  } catch {
    // 读不到时不影响本轮收尾。
  }
}

/**
 * 只有距上次成功同步超过最小间隔（5 分钟）时才请求同步。
 * 用于「后台转回前台」：短时间内反复切前后台不应该每次都发一轮请求。
 *
 * 读不到 last_synced_at（首次同步 / 库未就绪）时按「允许同步」处理，
 * 避免一次读库失败把前台同步永久关掉；没有账号时直接跳过，requestSync 本身也会回到 idle。
 */
export async function requestSyncIfDue(reason: SyncReason): Promise<void> {
  let due = true;
  try {
    const db = getDb();
    const scopeId = await getCurrentScope(db);
    if (!scopeId) {
      return;
    }
    const lastSyncedAt = await getMeta(db, scopeId, META_LAST_SYNCED_AT);
    due = isStale(lastSyncedAt, new Date(), SYNC_MIN_INTERVAL_MS);
  } catch {
    due = true;
  }

  if (!due) {
    return;
  }
  await requestSync(reason);
}

// 离线分支也要给出计数，但此时不能保证库已就绪（可能刚启动），因此整段兜底。
async function readSnapshotForState(): Promise<Snapshot> {
  try {
    const db = getDb();
    const scopeId = await getCurrentScope(db);
    return await readSnapshotSafe(db, scopeId);
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

// ---------------------------------------------------------------------------
// 自续期定时器

let timerHandle: ReturnType<typeof setTimeout> | null = null;

// 每次 start / stop 都递增：排期过程中的 await 结束后据此判断自己是否已过期。
// 只用 clearTimeout 不够——await 期间旧排期拿到的句柄还没赋值，停止时清不掉，
// 它醒来后会继续自续期，造成卸载后仍跑、或两次 start 并存。
let timerGeneration = 0;

// 是否允许定时器运行。stopSyncTimer（组件卸载 / 用户重置本地数据）会置 false，
// 防止正在飞的一轮同步在 finally 里把刚停掉的定时链又拉起来。
let timerAllowed = false;

function clearTimerHandle(): void {
  if (timerHandle !== null) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
}

export function stopSyncTimer(): void {
  timerGeneration += 1;
  timerAllowed = false;
  clearTimerHandle();
  // 保存后安排的补跑也一并取消：组件卸载 / 重置本地数据后不应再发整轮请求。
  clearDeferredHandle();
}

// 只允许「已启动」的定时器被重启。每次都重新 startSyncTimer 会递增 generation，
// 旧排期自动作废；这样即使旧排期刚好读到 pending=0 正在停表，也不会吞掉新的积压重试。
function ensureSyncTimer(): void {
  if (timerAllowed) {
    startSyncTimer();
  }
}

// 下一轮间隔只由「当前 pending 数」决定：有积压 60 秒重试，清空后返回 null 并停表。
// 排期读库失败时用默认间隔，绝不让定时链在异常状态下断掉。
async function scheduleNextSync(generation: number): Promise<void> {
  let delay: number | null = DB_READ_RETRY_INTERVAL_MS;
  try {
    const db = getDb();
    const scopeId = await getCurrentScope(db);
    if (generation !== timerGeneration) {
      return;
    }
    // 没有当前账号时同样停表：请求本身也没有可同步的目标。
    delay = scopeId ? nextSyncDelay(await readSnapshot(db, scopeId), new Date()) : null;
  } catch {
    // 库还没就绪：按默认间隔再来看一次。
  }

  // 第二次 await 之后同样要确认自己仍是最新的一代。
  if (generation !== timerGeneration) {
    return;
  }

  if (delay === null) {
    return;
  }

  timerHandle = setTimeout(() => {
    timerHandle = null;
    requestSync('timer')
      .catch(() => {})
      // 无论这轮是跑完、跳过还是失败，都重新排期：定时器自己续期，不依赖组件生命周期。
      .finally(() => {
        // stopSyncTimer 在同步期间被调用（组件卸载）就不再续期。
        if (generation === timerGeneration) {
          scheduleNextSync(generation).catch(() => {});
        }
      });
  }, delay);
}

/** 启动（或重置）自续期定时器。重复调用是安全的：旧排期因 generation 变化而作废。 */
export function startSyncTimer(): void {
  timerGeneration += 1;
  const generation = timerGeneration;
  timerAllowed = true;
  clearTimerHandle();
  scheduleNextSync(generation).catch(() => {});
}
