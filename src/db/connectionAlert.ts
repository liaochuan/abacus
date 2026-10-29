// 连接异常告警（spec §7.8 补充）：连续多天没能完整同步时，用弹窗把「多久没成功」讲清楚。
//
// 本文件只放纯判定，不做 IO：
// - 档位（0 / 3 / 7 天）与「这一档是否该再次提醒」都只依赖时间参数；
// - 读写 meta 的接线在 components/UI/SyncNoticeModal.tsx（用户确认）
//   与 db/sync.ts 的 markSynced（干净的一轮同步后清空）。
//
// 为什么按档位而不是每天提醒：告警把用户从当前操作里拉出来，必须收敛。
// 同档位最多每 24h 一次；天数继续累积则升档，升档立即提醒一次。

export type ConnectionAlertLevel = 0 | 3 | 7;

// meta 键。与 db/sync.ts 中的字面量保持一致（那边不导出，避免为一个字符串反向依赖 UI）。
export const CONNECTION_ALERT_LEVEL_META_KEY = 'connection_alert_level';
export const CONNECTION_ALERT_ACKNOWLEDGED_AT_META_KEY = 'connection_alert_acknowledged_at';
// 最近一次失败的错误分类，由 runSync 写入；无内容，可直接展示。
export const LAST_SYNC_ERROR_META_KEY = 'last_sync_error';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 距上次成功同步的整天数。向下取整：23 小时仍是 0 天。
 * 时间缺失 / 非法返回 null（调用方按「无从判断」处理，不告警）；
 * now 早于 lastSyncedAt（设备时钟被调回）按 0 天处理，不产生负数。
 */
export function daysSinceLastSync(lastSyncedAt: string | null, now: Date): number | null {
  if (!lastSyncedAt) {
    return null;
  }
  const last = Date.parse(lastSyncedAt);
  const current = now.getTime();
  if (!Number.isFinite(last) || !Number.isFinite(current)) {
    return null;
  }
  const elapsed = current - last;
  if (elapsed <= 0) {
    return 0;
  }
  return Math.floor(elapsed / DAY_MS);
}

/**
 * 告警档位：>= 7 天 → 7，>= 3 天 → 3，其余（含从未成功同步）→ 0。
 * 从未成功同步不告警：首轮同步失败由状态条与离线提示表达，弹窗会误伤刚装机的用户。
 */
export function connectionAlertLevel(
  lastSyncedAt: string | null,
  now: Date,
): ConnectionAlertLevel {
  const days = daysSinceLastSync(lastSyncedAt, now);
  if (days === null) {
    return 0;
  }
  if (days >= 7) {
    return 7;
  }
  if (days >= 3) {
    return 3;
  }
  return 0;
}

/**
 * 是否该把连接告警再显示一次。
 * - 0 档没有可展示的内容，直接 false；
 * - 升档（含从 0 到 3）立即提醒；
 * - 降档不提醒（更高档已经确认过，说明用户知道连接有问题）；
 * - 同档位 24 小时内不重复，超过 24h 或从未确认过 → 再提醒。
 */
export function shouldShowConnectionAlert(
  level: ConnectionAlertLevel,
  acknowledgedLevel: number,
  acknowledgedAt: string | null,
  now: Date,
): boolean {
  if (level <= 0) {
    return false;
  }
  if (level > acknowledgedLevel) {
    return true;
  }
  if (level < acknowledgedLevel) {
    return false;
  }

  const acknowledged = acknowledgedAt ? Date.parse(acknowledgedAt) : Number.NaN;
  if (!Number.isFinite(acknowledged)) {
    return true;
  }
  return now.getTime() - acknowledged > DAY_MS;
}
