import type { Db } from '../db/types';
import { getDb } from '../db/instance';
import { getMeta } from '../db/repository';
import { getCurrentScope } from '../db/scope';
import { AuthExpiredError, runSync } from '../db/sync';
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

// 同步调度层：所有触发点（启动、前台、网络恢复、定时器、手动、保存后）都只调 requestSync。
// 这里负责「什么时候能跑」与「跑完把状态写成什么」，不负责业务流水线（在 db/sync.ts）。
//
// 三条硬约束：
// 1. 永不阻塞 UI：调用方一律 `requestSync(...).catch(() => {})`；
// 2. 单飞：同一时刻只允许一轮（runExclusively），并发触发直接跳过；
// 3. 状态里只放固定枚举/短句与计数，绝不放 payload、token 或账户名。

export type SyncReason = 'manual' | 'startup' | 'online' | 'foreground' | 'timer' | 'after-save';

type Snapshot = {
  lastSyncedAt: string | null;
  pending: number;
  problems: number;
};

const EMPTY_SNAPSHOT: Snapshot = { lastSyncedAt: null, pending: 0, problems: 0 };

// meta 键与 db/sync.ts 保持一致（那边不导出，避免为了一个字符串把两个模块耦合起来）。
const META_LAST_SYNCED_AT = 'last_synced_at';

const DEFAULT_INTERVAL_MS = 600_000;

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
 * - 已有同步在跑：直接返回（不排队）。runExclusively 会复用进行中的 Promise，
 *   但触发点不需要等它，重复排队只会让状态条闪；
 * - 未登录 / 尚未选定账号：回到 idle，不报错；
 * - 失败：network → offline（下轮再试），其余 → error（固定短句）。
 */
export async function requestSync(reason: SyncReason): Promise<void> {
  if (!isOnline()) {
    setSyncState({ kind: 'offline', ...(await readSnapshotForState()) });
    return;
  }
  if (isSyncRunning()) {
    return;
  }

  await runExclusively(async () => {
    let db: Db;
    let scopeId = '';

    try {
      db = getDb();
    } catch {
      // 数据库尚未打开（bootstrap degraded）：没有可同步的目标，保持 idle，
      // 不把「库未就绪」显示成同步错误。触发点本身也只在 ready 阶段挂载。
      return;
    }

    // phase 只用于状态条文案：runSync 是一整轮黑盒，不能观测阶段切换，
    // 这里给「先 push 后 pull」的第一阶段，视觉上表示「正在同步」。
    setSyncState({ kind: 'syncing', phase: 'push' });

    try {
      // current_scope 只在这里读一次，后续 buildSyncContext / runSync 都用同一个值；
      // 上下文组装完后再校验一次，账号在 await 期间被切换就放弃本轮。
      scopeId = await getCurrentScope(db);
      const ctx = scopeId ? await buildSyncContext(scopeId) : null;
      if (ctx === null) {
        setSyncState({ kind: 'idle', ...(await readSnapshotSafe(db, scopeId)) });
        return;
      }

      const currentScope = await getCurrentScope(db);
      if (currentScope !== scopeId) {
        // 本轮上下文仍属于旧账号：直接结束，不写入任何 outbox/交易，
        // 状态条按新 scope 的真实计数回到 idle。
        setSyncState({ kind: 'idle', ...(await readSnapshotSafe(db, currentScope)) });
        return;
      }

      const before = await readSnapshotSafe(db, scopeId);
      // 首次同步（从没有过成功记录）拉 365 天做一次回填；之后都是 90 天增量窗口。
      // 启动与手动都可以承担回填：启动同步与首页 focus 的 manual 几乎同时到达，
      // 单飞锁只保留其中一个，只看 reason 会让首轮回填随机丢失。
      await runSync(db, scopeId, ctx, {
        full: before.lastSyncedAt === null && (reason === 'startup' || reason === 'manual'),
      });

      setSyncState({ kind: 'idle', ...(await readSnapshotSafe(db, scopeId)) });
    } catch (error) {
      const snapshot = await readSnapshotSafe(db, scopeId);
      if (classifySyncError(error) === 'network') {
        // 拉取途中断网：语义是「这轮因为离线没跑成」，状态条显示离线而不是报错。
        setSyncState({ kind: 'offline', ...snapshot });
      } else {
        setSyncState({ kind: 'error', message: errorMessage(error), ...snapshot });
      }
    } finally {
      emitSyncChanged();
    }
  });
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

function clearTimerHandle(): void {
  if (timerHandle !== null) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
}

export function stopSyncTimer(): void {
  timerGeneration += 1;
  clearTimerHandle();
}

// 下一轮间隔取决于「当前 pending 数」：有积压 60 秒，清空后 10 分钟。
// 排期读库失败时用默认间隔，绝不让定时链断掉。
async function scheduleNextSync(generation: number): Promise<void> {
  let delay = DEFAULT_INTERVAL_MS;
  try {
    const db = getDb();
    const scopeId = await getCurrentScope(db);
    if (generation !== timerGeneration) {
      return;
    }
    if (scopeId) {
      delay = nextSyncDelay(await readSnapshot(db, scopeId), new Date());
    }
  } catch {
    // 库还没就绪：按默认间隔再来看一次。
  }

  // 第二次 await 之后同样要确认自己仍是最新的一代。
  if (generation !== timerGeneration) {
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
  clearTimerHandle();
  scheduleNextSync(generation).catch(() => {});
}
