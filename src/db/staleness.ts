// 过期判定：fetchedAt 缺失或解析失败一律视为过期；now - fetchedAt 超过 ttlMs 视为过期。
// 默认 TTL 10 分钟（600000ms），对齐 spec 的离线缓存新鲜度阈值。
export function isStale(fetchedAt: string | null, now: Date, ttlMs = 600_000): boolean {
  if (fetchedAt === null) {
    return true;
  }
  const fetchedTime = new Date(fetchedAt).getTime();
  if (Number.isNaN(fetchedTime)) {
    return true;
  }
  return now.getTime() - fetchedTime > ttlMs;
}
