import type { TransactionSplitType, TransactionType } from '../models/transactions';
import type { Db } from './types';

// notices 仓储 + 冲突 diff。
// 表结构见 schema.ts：
// - conflict：local_payload 是本地版本，server_payload 是服务端版本；
// - server_deletion：local_payload 为 NULL，server_payload 是删除前的最后一份本地快照
//   （由 reconcileDeletions 写入），这样用户仍能看到被删掉了哪一笔。
//
// 本文件只做「读未确认提示 / 确认一条 / 计算差异」三件事，
// 不改 outbox、不发网络请求；渲染与文案在 components/UI/SyncNoticeModal.tsx。

export type NoticeKind = 'conflict' | 'server_deletion';

export type NoticeRow = {
  id: string;
  kind: NoticeKind;
  entityId: string;
  localPayload: TransactionType | null;
  serverPayload: TransactionType;
  detectedAt: string;
};

type NoticeDbRow = {
  id: string;
  kind: string;
  entity_id: string;
  local_payload: string | null;
  server_payload: string;
  detected_at: string;
};

// 弹窗一次最多展示的数量：提示只会由「同一 entity 的同 kind 未确认行」去重累积，
// 正常情况是几条；加上上限是为了不让一次全量对账后的极端情况把整表读进内存。
// 超出的行保持未确认，用户关掉已展示的几条后会出现在下一批。
const MAX_OPEN_NOTICES = 100;

// 解析失败时的占位：宁可显示一条信息不完整的提示，也不要静默丢掉一行未确认记录，
// 否则它的计数会永远留在「需处理」里而用户无法关闭。
const EMPTY_PAYLOAD: TransactionType = {
  id: '',
  type: '',
  attributes: {
    groupTitle: '',
    transactions: [],
    user: '',
    createdAt: '',
    updatedAt: '',
  },
};

function parsePayload(raw: string | null | undefined, fallback: TransactionType): TransactionType;
function parsePayload(raw: string | null | undefined, fallback: null): TransactionType | null;
function parsePayload(
  raw: string | null | undefined,
  fallback: TransactionType | null,
): TransactionType | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return fallback;
    }
    return parsed as TransactionType;
  } catch {
    return fallback;
  }
}

const asKind = (kind: string): NoticeKind | null => {
  if (kind === 'conflict' || kind === 'server_deletion') {
    return kind;
  }
  return null;
};

const toRow = (row: NoticeDbRow): NoticeRow | null => {
  const kind = asKind(row.kind);
  if (kind === null) {
    // 未知 kind：本版本没有对应的展示方式，跳过而不是当成冲突渲染。
    return null;
  }
  return {
    id: row.id,
    kind,
    entityId: row.entity_id,
    localPayload: parsePayload(row.local_payload, null),
    serverPayload: parsePayload(row.server_payload, EMPTY_PAYLOAD),
    detectedAt: row.detected_at,
  };
};

/**
 * 当前 scope 下所有未确认提示，按发现时间升序（先发现的先处理）。
 * `id ASC` 作为次级排序：detected_at 只到毫秒，同毫秒的两行必须有确定顺序。
 */
export async function listOpenNotices(db: Db, scopeId: string): Promise<NoticeRow[]> {
  if (!scopeId) {
    return [];
  }
  const rows = await db.all<NoticeDbRow>(
    `SELECT id, kind, entity_id, local_payload, server_payload, detected_at
     FROM notices
     WHERE scope_id = ? AND acknowledged_at IS NULL
     ORDER BY detected_at ASC, id ASC
     LIMIT ?`,
    [scopeId, MAX_OPEN_NOTICES],
  );
  return rows
    .map(toRow)
    .filter((row): row is NoticeRow => row !== null);
}

/**
 * 用户点「关闭」：只回填 acknowledged_at，不删除行（保留「曾经提示过」的痕迹）。
 * 必须带 scope_id：id 虽是主键，但按项目硬规则所有语句都做 scope 过滤。
 * 已确认的行不会被重复覆盖时间戳。
 */
export async function acknowledgeNotice(db: Db, id: string, scopeId: string): Promise<void> {
  if (!id || !scopeId) {
    return;
  }
  await db.run(
    `UPDATE notices SET acknowledged_at = ?
     WHERE scope_id = ? AND id = ? AND acknowledged_at IS NULL`,
    [new Date().toISOString(), scopeId, id],
  );
}

// ---------------------------------------------------------------------------
// 冲突 diff

export type TransactionDiff = {
  /** 组级字段为 `group_title`，split 级为模型里的 camelCase 字段名；
   *  数量不一致时为 `split_missing_on_server` / `split_missing_locally`。 */
  field: string;
  /** -1 表示组级字段；其余是 split 下标（从 0 开始）。 */
  split: number;
  local: string;
  server: string;
};

// 逐 split 比较的字段（顺序即展示顺序）。id / categoryId 之类的内部标识不展示，
// 名称字段已足以让用户判断差异；金额、日期另行按值归一化。
const SPLIT_FIELDS = [
  'description',
  'amount',
  'date',
  'type',
  'categoryName',
  'budgetName',
  'tags',
  'notes',
  'sourceName',
  'destinationName',
] as const;

type SplitField = typeof SPLIT_FIELDS[number];

const pad2 = (value: number): string => `${value}`.padStart(2, '0');

// 日期只比到天：payload 里可能是 '2026-10-01'、ISO 串或 Date（本地新建时是 Date），
// 直接比较原值会把「同一天的不同表示」误报成差异。
const dateKey = (value: unknown): string => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return '';
    }
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, 10);
};

const tagsOf = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((tag) => String(tag).trim())
    .filter((tag) => tag.length > 0);
};

const displayValue = (field: string, value: unknown): string => {
  if (field === 'date') {
    return dateKey(value);
  }
  if (field === 'tags') {
    return tagsOf(value).join(', ');
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
};

const amountsEqual = (local: unknown, server: unknown): boolean | null => {
  const left = String(local ?? '').trim();
  const right = String(server ?? '').trim();
  if (left === '' || right === '') {
    return null;
  }
  const parsedLeft = Number(left.replace(/,/g, ''));
  const parsedRight = Number(right.replace(/,/g, ''));
  if (!Number.isFinite(parsedLeft) || !Number.isFinite(parsedRight)) {
    return null;
  }
  return parsedLeft === parsedRight;
};

const sameValue = (field: SplitField, local: unknown, server: unknown): boolean => {
  if (field === 'amount') {
    // '1' 与 '1.00' 是同一笔金额，不该占用一条提示。
    const equal = amountsEqual(local, server);
    if (equal !== null) {
      return equal;
    }
  }
  if (field === 'tags') {
    // 标签顺序不同不算改动，按集合比较。
    return tagsOf(local).sort().join('\n') === tagsOf(server).sort().join('\n');
  }
  return displayValue(field, local) === displayValue(field, server);
};

const splitLabel = (split: TransactionSplitType): string => [
  displayValue('description', split.description),
  displayValue('amount', split.amount),
].filter((part) => part.length > 0).join(' · ');

const splitsOf = (payload: TransactionType | null | undefined): TransactionSplitType[] => {
  const splits = payload?.attributes?.transactions;
  return Array.isArray(splits) ? splits : [];
};

/**
 * 比较本地与服务端两版交易，返回可直接渲染的差异列表。
 * 缺失的 split 每个占一条（field 为 `split_missing_*`），其余按下标逐字段比较。
 * 纯函数：不做 IO，也不做文案翻译。
 */
export function diffTransaction(
  local: TransactionType,
  server: TransactionType,
): TransactionDiff[] {
  const diff: TransactionDiff[] = [];
  const localTitle = displayValue('groupTitle', local?.attributes?.groupTitle);
  const serverTitle = displayValue('groupTitle', server?.attributes?.groupTitle);
  if (localTitle !== serverTitle) {
    diff.push({
      field: 'group_title', split: -1, local: localTitle, server: serverTitle,
    });
  }

  const localSplits = splitsOf(local);
  const serverSplits = splitsOf(server);
  const count = Math.max(localSplits.length, serverSplits.length);

  for (let index = 0; index < count; index += 1) {
    const localSplit = localSplits[index];
    const serverSplit = serverSplits[index];

    if (localSplit && !serverSplit) {
      diff.push({
        field: 'split_missing_on_server', split: index, local: splitLabel(localSplit), server: '',
      });
      continue;
    }
    if (!localSplit && serverSplit) {
      diff.push({
        field: 'split_missing_locally', split: index, local: '', server: splitLabel(serverSplit),
      });
      continue;
    }
    if (!localSplit || !serverSplit) {
      continue;
    }

    SPLIT_FIELDS.forEach((field) => {
      if (!sameValue(field, localSplit[field], serverSplit[field])) {
        diff.push({
          field,
          split: index,
          local: displayValue(field, localSplit[field]),
          server: displayValue(field, serverSplit[field]),
        });
      }
    });
  }

  return diff;
}
