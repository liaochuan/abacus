import { nextPageOffset } from '../pagination';

test('本地分页偏移', () => {
  expect(nextPageOffset({ offset: 0, limit: 15, received: 15 }, 40)).toBe(15);
  expect(nextPageOffset({ offset: 30, limit: 15, received: 10 }, 40)).toBeNull();
  expect(nextPageOffset({ offset: 0, limit: 15, received: 0 }, 0)).toBeNull();
});

// ---- 边界补充：满页恰好到总数时不再翻页；空页结束；短页结束 ----
test('满页但已到 total 时结束', () => {
  expect(nextPageOffset({ offset: 15, limit: 15, received: 15 }, 30)).toBeNull();
});

test('未满页即使还有 total 也结束（本地库最后一页）', () => {
  expect(nextPageOffset({ offset: 0, limit: 50, received: 49 }, Number.POSITIVE_INFINITY)).toBeNull();
});

test('total 未知时以满页为界', () => {
  expect(nextPageOffset({ offset: 50, limit: 50, received: 50 }, Number.POSITIVE_INFINITY)).toBe(100);
});
