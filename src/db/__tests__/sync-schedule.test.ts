import { nextSyncDelay } from '../syncState';

test('有 pending 时 60 秒重试，空闲时不排期', () => {
  const now = new Date('2026-10-27T00:00:00Z');
  expect(nextSyncDelay({ pending: 3, lastSyncedAt: null }, now)).toBe(60_000);
  expect(nextSyncDelay({ pending: 0, lastSyncedAt: '2026-10-26T00:00:00Z' }, now)).toBeNull();
});
