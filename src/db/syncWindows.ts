// 同步引擎的纯函数：时间窗口与本地对账。刻意不依赖 moment/dayjs，
// 也不碰数据库与网络，便于在 outbox 调度与单元测试中直接复用。
import type { TransactionSplitType, TransactionType } from '../models/transactions';

const INCREMENTAL_DAYS = 90;
const FULL_DAYS = 365;

// 本地日历日 YYYY-MM-DD。不能用 toISOString()，那会按 UTC 切日。
function toLocalDate(value: Date): string {
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

// setDate 按日历日回退，跨月、跨年、闰年与夏令时都由运行时正确处理；
// 在副本上操作，不修改调用方传入的 now。
export function computePullWindow(now: Date, full: boolean): { start: string; end: string } {
  const start = new Date(now.getTime());
  start.setDate(start.getDate() - (full ? FULL_DAYS : INCREMENTAL_DAYS));
  return { start: toLocalDate(start), end: toLocalDate(now) };
}

function firstSplit(transaction: TransactionType | null | undefined): TransactionSplitType | null {
  const splits = transaction?.attributes?.transactions;
  if (!Array.isArray(splits) || splits.length === 0) {
    return null;
  }
  return splits[0] ?? null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// 同一天比较统一落到本地日历日；纯日期字符串本身不含时区，直接视为本地日期。
function localDayOf(value: TransactionSplitType['date'] | null | undefined): string | null {
  if (typeof value === 'string') {
    if (DATE_ONLY.test(value)) {
      return value;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : toLocalDate(parsed);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toLocalDate(value);
  }
  return null;
}

// 金额在模型里是字符串，可能带千分位之外的本地化小数逗号（如 '3,50'）。
// 先归一化再按 Number 解析；空串/纯空白视为无效，避免两笔都缺金额时被当成 0 匹配。
function toAmount(value: string | null | undefined): number {
  const normalized = String(value ?? '').trim().replace(',', '.');
  return normalized === '' ? Number.NaN : Number(normalized);
}

function sameAmount(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = toAmount(left);
  const b = toAmount(right);
  return !Number.isNaN(a) && !Number.isNaN(b) && a === b;
}

function sameText(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? '') === (right ?? '');
}

function isSameTransaction(candidate: TransactionSplitType, payload: TransactionSplitType): boolean {
  const candidateDay = localDayOf(candidate.date);
  const payloadDay = localDayOf(payload.date);
  return (
    candidateDay !== null
    && payloadDay !== null
    && candidateDay === payloadDay
    && sameText(candidate.description, payload.description)
    && sameAmount(candidate.amount, payload.amount)
    && sameText(candidate.sourceName, payload.sourceName)
    && sameText(candidate.destinationName, payload.destinationName)
  );
}

// 对账：服务端可能已经收下了离线期间创建的这笔交易，此时再推送会产生重复。
// 只比较首笔 split（一笔交易是否重复由主 split 决定），且必须唯一匹配，
// 多笔候选同时命中时宁可返回 null 交由调用方重试，也不猜。
// 注意：push create 的对账要用更严格的 pickDuplicateGroup（整组一致 + createdAt 下界），
// 本函数保留给只看主 split 的宽松场景（例如更新前的粗筛）。
export function pickDuplicate(
  candidates: TransactionType[],
  payload: TransactionType,
): TransactionType | null {
  const target = firstSplit(payload);
  if (target === null) {
    return null;
  }
  const matches = candidates.filter((candidate) => {
    const split = firstSplit(candidate);
    return split !== null && isSameTransaction(split, target);
  });
  return matches.length === 1 ? matches[0] : null;
}

// 候选组的 createdAt 早于本地入队时间即视为「更早就存在的另一笔交易」，不算重复。
// 任一侧缺失或无法解析时不下判断（宁可让它进入后续比较，也不因时间戳格式问题漏判）。
function isOlderThan(candidate: TransactionType, notBefore: string | null | undefined): boolean {
  if (!notBefore) {
    return false;
  }
  const createdAt = candidate?.attributes?.createdAt;
  if (typeof createdAt !== 'string' || createdAt === '') {
    return false;
  }
  const candidateTime = Date.parse(createdAt);
  const boundTime = Date.parse(notBefore);
  if (Number.isNaN(candidateTime) || Number.isNaN(boundTime)) {
    return false;
  }
  return candidateTime < boundTime;
}

// 严格对账：整组一致才算重复——split 数量相同，且每一笔 split 的日期（本地日历日）、
// 描述、金额（数值）、来源、去向都相同。只比首笔会把「同一天同金额同账户的另一笔」
// 误判成重复，绑定后就丢了用户新录入的那笔。
// notBefore 传本地入队时间（outbox.created_at）：服务端组创建时间更早时一定不是这次创建的。
// 仍要求唯一匹配；多候选返回 null，由调用方重试或保留原错误，绝不猜。
export function pickDuplicateGroup(
  candidates: TransactionType[],
  payload: TransactionType,
  notBefore?: string | null,
): TransactionType | null {
  const targetSplits = payload?.attributes?.transactions;
  if (!Array.isArray(targetSplits) || targetSplits.length === 0) {
    return null;
  }
  const matches = candidates.filter((candidate) => {
    const splits = candidate?.attributes?.transactions;
    if (!Array.isArray(splits) || splits.length !== targetSplits.length) {
      return false;
    }
    const same = splits.every((split, index) => isSameTransaction(split, targetSplits[index]));
    return same && !isOlderThan(candidate, notBefore);
  });
  return matches.length === 1 ? matches[0] : null;
}
