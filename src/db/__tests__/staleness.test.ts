import { isStale } from '../staleness';

test('超过 10 分钟视为过期，缺失视为过期', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  expect(isStale('2026-10-27T11:55:00Z', now)).toBe(false);
  expect(isStale('2026-10-27T11:45:00Z', now)).toBe(true);
  expect(isStale(null, now)).toBe(true);
});

test('自定义 TTL 与解析失败', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  // 恰好等于 TTL（5 分钟）不算过期，超过才算过期
  expect(isStale('2026-10-27T11:55:00Z', now, 300_000)).toBe(false);
  expect(isStale('2026-10-27T11:54:59Z', now, 300_000)).toBe(true);
  // 无法解析的时间戳按过期处理
  expect(isStale('not-a-date', now)).toBe(true);
});
