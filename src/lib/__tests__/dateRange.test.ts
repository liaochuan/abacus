import { startOfCurrentQuarter } from '../dateRange';

const expectDate = (actual: Date, expected: Date) => {
  expect(actual.getFullYear()).toBe(expected.getFullYear());
  expect(actual.getMonth()).toBe(expected.getMonth());
  expect(actual.getDate()).toBe(expected.getDate());
  expect(actual.getHours()).toBe(0);
  expect(actual.getMinutes()).toBe(0);
  expect(actual.getSeconds()).toBe(0);
  expect(actual.getMilliseconds()).toBe(0);
};

test('返回当前季度第一天的本地零点', () => {
  // 2026-10-27 → Q4 起点 2026-10-01
  expectDate(startOfCurrentQuarter(new Date(2026, 9, 27, 15, 30)), new Date(2026, 9, 1));
  // 2026-02-15 → Q1 起点 2026-01-01
  expectDate(startOfCurrentQuarter(new Date(2026, 1, 15, 23, 59)), new Date(2026, 0, 1));
  // 2026-12-31 → Q4 起点 2026-10-01
  expectDate(startOfCurrentQuarter(new Date(2026, 11, 31, 23, 59)), new Date(2026, 9, 1));
});

test('季度边界：4/1、7/1 属于新季度', () => {
  expectDate(startOfCurrentQuarter(new Date(2026, 3, 1, 0, 0)), new Date(2026, 3, 1));
  expectDate(startOfCurrentQuarter(new Date(2026, 6, 30, 12, 0)), new Date(2026, 6, 1));
});

test('缺省参数返回 Date 且为季度起点', () => {
  const result = startOfCurrentQuarter();
  expect(result).toBeInstanceOf(Date);
  expect(result.getMonth() % 3).toBe(0);
  expect(result.getDate()).toBe(1);
  expect(result.getHours()).toBe(0);
});
