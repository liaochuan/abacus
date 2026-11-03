// 同步状态的模块级原语：状态快照、变更订阅、单飞锁。
// 本文件不做触发接线、不组装 SyncContext、不读写数据库——那些在 03-T8 的 requestSync 里完成，
// 04 的 useSyncSummary 只订阅这里的事件并在需要时刷新。
//
// 为什么用模块级变量而不是 Context：同步是全局的（一个账号一个 scope），
// 触发来源分散在启动、前台、网络恢复、定时器与手动按钮，没有共同的 React 祖先可挂。

/**
 * 状态机（spec §7.7）。字段含义：
 * - syncing 只有阶段，不带计数——同步中的计数由订阅方从库里读；
 * - offline 与 idle 同形，区别只在「最后一轮是否因为离线没跑成」；
 * - error 带一条固定的、无内容的短消息（不得包含 token、账户名或备注）。
 */
export type SyncState =
  | { kind: 'idle'; lastSyncedAt: string | null; pending: number; problems: number }
  | { kind: 'syncing'; phase: 'push' | 'pull' }
  | { kind: 'offline'; lastSyncedAt: string | null; pending: number; problems: number }
  | { kind: 'error'; message: string; lastSyncedAt: string | null; pending: number; problems: number };

// 定时同步的输入快照（只读，由调度层在每次排期前查一次库）。
export type SyncSchedule = {
  /** 待推送的 outbox 行数。 */
  pending: number;
  /** meta.last_synced_at；仅用于调用方判断是否首次同步。 */
  lastSyncedAt: string | null;
};

const PENDING_INTERVAL_MS = 60_000;

// 下一轮定时同步的间隔（毫秒）。只有 outbox 有积压时才排期（60 秒重试）；
// 队列清空后返回 null，调度层据此停掉定时器，避免空闲期每 10 分钟空转一次请求。
// 冷启动、前台恢复与下拉刷新由各自的触发点负责，不依赖这个定时器。
// lastSyncedAt 与 now 目前不改变间隔，保留在签名里，便于调用方统一计算。
// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
export function nextSyncDelay({ pending }: SyncSchedule, now: Date): number | null {
  return pending > 0 ? PENDING_INTERVAL_MS : null;
}

type SyncListener = () => void;

const listeners = new Set<SyncListener>();

let currentState: SyncState = {
  kind: 'idle',
  lastSyncedAt: null,
  pending: 0,
  problems: 0,
};

/**
 * 订阅状态变更，返回取消订阅函数。
 * 监听器故意不收参数：订阅方需要的是「去重新读一遍摘要」，而不是让事件携带快照，
 * 否则并发同步与 outbox 变化可能给出互相覆盖的旧值。
 */
export function subscribeSyncChanged(listener: SyncListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 通知所有订阅方状态可能已变化。
 * 在同步结束、outbox 变化、网络状态变化时调用（由 03-T8 / 04-T1 接线）。
 * 单个监听器抛错不影响其它监听器，也不影响调用方。
 */
export function emitSyncChanged(): void {
  // 复制一份再遍历：监听器在回调里取消订阅（组件卸载）不会破坏本次派发。
  [...listeners].forEach((listener) => {
    try {
      listener();
    } catch {
      // 忽略单个订阅方的异常：状态通知是尽力而为，不反过来打断同步流程。
    }
  });
}

export function getSyncState(): SyncState {
  return currentState;
}

/**
 * 当前状态是否处于「连接异常」。
 * 状态条与连接告警必须用同一判定：状态条说「已同步」、弹窗说「连不上」是自相矛盾的。
 * 只认 error：offline 是用户已知的常态（状态条已显示离线），不该再弹窗。
 */
export function isSyncFailing(state: SyncState): boolean {
  return state.kind === 'error';
}

/** 写入状态快照并广播。相同引用时也广播——调用方按「有变化」语义传入即可。 */
export function setSyncState(next: SyncState): void {
  currentState = next;
  emitSyncChanged();
}

// ---------------------------------------------------------------------------
// 单飞锁

let inFlight: Promise<void> | null = null;

/** 当前是否有同步任务在跑。状态条据此禁用按钮并显示加载。 */
export function isSyncRunning(): boolean {
  return inFlight !== null;
}

/**
 * 同一时刻只允许一个同步任务（spec §7.7：模块级 Promise 互斥，不用 DB 锁）。
 * 并发调用不会排队也不会启动第二个任务，而是直接复用进行中的 Promise，
 * 因此第二次触发（例如用户连点、定时器与前台同时到）只是等同一轮结束。
 * 用 `Promise.resolve().then(...)` 启动，保证 finally 一定在 `inFlight` 赋值之后执行：
 * 任务体在第一个 await 之前抛错时锁也能正确释放。
 */
export function runExclusively(task: () => Promise<void>): Promise<void> {
  if (inFlight !== null) {
    return inFlight;
  }
  const started = Promise.resolve()
    .then(task)
    .finally(() => {
      inFlight = null;
    });
  inFlight = started;
  return started;
}
