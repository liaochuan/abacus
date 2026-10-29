import { nextSyncDelay } from '../syncState';

test('有 pending 时 60 秒，否则 10 分钟', () => {
  const now = new Date('2026-10-27T00:00:00Z');
  expect(nextSyncDelay({ pending: 3, lastSyncedAt: null }, now)).toBe(60_000);
  expect(nextSyncDelay({ pending: 0, lastSyncedAt: '2026-10-26T00:00:00Z' }, now)).toBe(600_000);
});
