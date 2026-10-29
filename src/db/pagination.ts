// 本地分页：给定当前页状态与总数，返回下一页的 offset，或 null 表示已经到底。
// 结束条件：
//   - 本页没有收到任何数据（空页）；
//   - 本页是短页（received < limit），说明后面不会再有数据；
//   - 已累计到 total。
// total 未知时调用方可传 Number.POSITIVE_INFINITY（本地库没有廉价 COUNT），
// 此时仅靠短页/空页判断结束。
export type PageState = {
  offset: number;
  limit: number;
  received: number;
};

export function nextPageOffset({ offset, limit, received }: PageState, total: number): number | null {
  if (received <= 0 || received < limit) {
    return null;
  }
  const next = offset + limit;
  if (next >= total) {
    return null;
  }
  return next;
}
