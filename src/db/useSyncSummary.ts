import { useEffect, useState } from 'react';

import { isOnline, subscribeNetwork } from '../lib/network';
import { getDb } from './instance';
import { getMeta } from './repository';
import { getCurrentScope } from './scope';
import { subscribeSyncChanged } from './syncState';
import type { Db } from './types';

// 同步摘要：状态条唯一需要的数据。
// 数据源在库里（outbox / notices / meta），事件只承担「可能变了，去重读」的信号——
// 与 syncState.ts 的设计一致：事件不带快照，避免并发同步与本地写入互相覆盖旧值。
//
// 为什么单独放一个 hook 而不是复用 syncState 的 currentState：状态机里的 pending/problems
// 只在 requestSync 跑完时写一次，用户离线编辑后不会更新；这里始终按库里的真实计数读，
// 且订阅了 outbox 变化（saveLocalTransaction 等路径会 emitSyncChanged）。

export type SyncSummary = {
  online: boolean;
  pending: number;
  problems: number;
  lastSyncedAt: string | null;
};

export type SyncSummaryInput = {
  online: boolean;
  pending: number;
  failedOutbox: number;
  unacknowledgedNotices: number;
  lastSyncedAt: string | null;
};

/** 首次读取完成前的占位值：避免调用方处理 undefined，也保证首帧不会被当成离线。 */
export const DEFAULT_SYNC_SUMMARY: SyncSummary = {
  online: true,
  pending: 0,
  problems: 0,
  lastSyncedAt: null,
};

// meta 键与 db/sync.ts、lib/syncScheduler.ts 保持一致（那边不导出，避免为一个字符串耦合两个模块）。
const META_LAST_SYNCED_AT = 'last_synced_at';

/** 纯映射：把三类计数合成状态条要的两个数字。problems = 失败项 + 未确认提示。 */
export function summarize(input: SyncSummaryInput): SyncSummary {
  return {
    online: input.online,
    pending: input.pending,
    problems: input.failedOutbox + input.unacknowledgedNotices,
    lastSyncedAt: input.lastSyncedAt,
  };
}

/**
 * 按 scope 读一次摘要。
 * 三条查询都有界且走既有索引：outbox(scope_id, status, created_at)、
 * notices(scope_id, acknowledged_at)、meta 主键；不做全表扫描，也不读 payload。
 * scopeId 为空（尚未选定账号）时直接返回空摘要，避免把 `_global` 的数据算进来。
 */
export async function readSyncSummary(
  db: Db,
  scopeId: string,
  online: boolean,
): Promise<SyncSummary> {
  if (!scopeId) {
    return summarize({
      online,
      pending: 0,
      failedOutbox: 0,
      unacknowledgedNotices: 0,
      lastSyncedAt: null,
    });
  }

  // pending 与 failed 用一条聚合读出来：同一 scope 的 outbox 行只扫一次，
  // 且 sent / conflict 行自然被 CASE 排除（conflict 由 notices 表达）。
  const outbox = await db.get<{ pending: number | null; failed: number | null }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
     FROM outbox
     WHERE scope_id = ?`,
    [scopeId],
  );
  const notices = await db.get<{ count: number | null }>(
    'SELECT COUNT(*) AS count FROM notices WHERE scope_id = ? AND acknowledged_at IS NULL',
    [scopeId],
  );
  const lastSyncedAt = await getMeta(db, scopeId, META_LAST_SYNCED_AT);

  return summarize({
    online,
    pending: Number(outbox?.pending ?? 0),
    failedOutbox: Number(outbox?.failed ?? 0),
    unacknowledgedNotices: Number(notices?.count ?? 0),
    lastSyncedAt,
  });
}

/**
 * 订阅同步摘要。挂载、同步事件、网络状态变化时都重新查库。
 * 读库失败（库未就绪 / 已删账号）时保留上一次的计数，只更新 online——
 * 状态条不该因为一次读失败就把「还有 3 条待上传」清成 0。
 */
export function useSyncSummary(): SyncSummary {
  const [summary, setSummary] = useState<SyncSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 多次 load 可能乱序返回（同步事件连着来）：只让最后一次写入 state。
    let generation = 0;

    const load = async (onlineOverride?: boolean) => {
      generation += 1;
      const current = generation;
      const online = onlineOverride ?? isOnline();

      try {
        const db = getDb();
        const scopeId = await getCurrentScope(db);
        const next = await readSyncSummary(db, scopeId, online);
        if (!cancelled && current === generation) {
          setSummary(next);
        }
      } catch {
        if (!cancelled && current === generation) {
          setSummary((prev) => ({ ...(prev ?? DEFAULT_SYNC_SUMMARY), online }));
        }
      }
    };

    load();
    const unsubscribeSync = subscribeSyncChanged(() => {
      load();
    });
    // 网络变化立即反映到 online（事件参数就是最新值），并借机重读离线期间积压的计数。
    const unsubscribeNetwork = subscribeNetwork((online) => {
      load(online);
    });

    return () => {
      cancelled = true;
      unsubscribeSync();
      unsubscribeNetwork();
    };
  }, []);

  return summary ?? DEFAULT_SYNC_SUMMARY;
}
