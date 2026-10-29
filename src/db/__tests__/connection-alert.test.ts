import {
  connectionAlertLevel,
  daysSinceLastSync,
  shouldShowConnectionAlert,
} from '../connectionAlert';

// 纯函数：不含 IO，时间一律由参数注入，避免依赖真实时钟。
test('档位随时间升级', () => {
  const now = new Date('2026-10-27T00:00:00Z');
  expect(connectionAlertLevel('2026-10-26T00:00:00Z', now)).toBe(0);
  expect(connectionAlertLevel('2026-10-23T00:00:00Z', now)).toBe(3);
  expect(connectionAlertLevel('2026-10-19T00:00:00Z', now)).toBe(7);
  expect(connectionAlertLevel(null, now)).toBe(0);
});

test('同档位 24 小时内不重复', () => {
  const now = new Date('2026-10-27T00:00:00Z');
  expect(shouldShowConnectionAlert(3, 3, '2026-10-26T12:00:00Z', now)).toBe(false);
  expect(shouldShowConnectionAlert(3, 3, '2026-10-25T00:00:00Z', now)).toBe(true);
  expect(shouldShowConnectionAlert(7, 3, '2026-10-27T00:00:00Z', now)).toBe(true);
});

test('0 档不告警，降档后不再提醒已确认过的更高档', () => {
  const now = new Date('2026-10-27T00:00:00Z');
  expect(shouldShowConnectionAlert(0, 0, null, now)).toBe(false);
  expect(shouldShowConnectionAlert(3, 7, null, now)).toBe(false);
});

test('同档位从未确认过时应当提醒', () => {
  const now = new Date('2026-10-27T00:00:00Z');
  expect(shouldShowConnectionAlert(3, 3, null, now)).toBe(true);
  expect(shouldShowConnectionAlert(3, 3, 'not-a-date', now)).toBe(true);
});

test('确认 7 档后干净同步归零，新的 3 天断网应重新提醒', () => {
  const now = new Date('2026-10-30T00:00:00Z');
  // 干净同步会删除 connection_alert_level / acknowledged_at，读回即 0 / null。
  // 若只清确认时间而留下 7，3 > 7 为假，告警会一直沉默到第 7 天。
  expect(shouldShowConnectionAlert(3, 0, null, now)).toBe(true);
});

test('整天数：不足一天为 0，非法时间没有天数', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  expect(daysSinceLastSync('2026-10-27T00:00:00Z', now)).toBe(0);
  expect(daysSinceLastSync('2026-10-20T12:00:00Z', now)).toBe(7);
  expect(daysSinceLastSync(null, now)).toBeNull();
  expect(daysSinceLastSync('not-a-date', now)).toBeNull();
  // 未来时间（设备时钟被调回）按 0 处理，不产生负数告警。
  expect(daysSinceLastSync('2026-10-28T00:00:00Z', now)).toBe(0);
});
