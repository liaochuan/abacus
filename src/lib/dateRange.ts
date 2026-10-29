// 当前季度第一天（本地时区 00:00）。交易列表的默认起始日期用它，
// 不依赖 Redux 的 firefly.rangeDetails（该 slice 已被 persist blacklist 排除）。
// eslint-disable-next-line import/prefer-default-export
export function startOfCurrentQuarter(now: Date = new Date()): Date {
  const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
  return new Date(now.getFullYear(), quarterStartMonth, 1);
}
