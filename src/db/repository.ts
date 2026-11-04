import type { Db } from './types';
import type { TransactionType } from '../models/transactions';
import { enqueue } from './outbox';
import { emitSyncChanged } from './syncState';

// meta 与 blobs 仓储层。表结构见 schema.ts（spec §7.3）；所有 SQL 一律用绑定参数，
// 不拼接数据值（pruneBlobs 的 NOT IN 占位符按 keepKeys 个数生成，仅 "?" 与逗号）。

export type Blob<T> = {
  payload: T;
  fetchedAt: string;
};

// 永不参与区间修剪的第一段字面量，逐字对齐 keys.ts 的豁免清单。
const NEVER_PRUNE_PREFIXES = ['autocomplete', 'piggy_banks', 'bills', 'currencies'];

// 把 blob 键解析成 `start:end` 区间。chart:* 键前缀多一段（chart:kind:...），
// 区间在第 3、4 段（0-based 下标 2、3）；其余键在第 2、3 段（下标 1、2）。
// 缺段按空串补位，保证解析结果确定（此类键排序最靠后，正常会随最旧组被修剪）。
const rangeOfKey = (key: string): string => {
  const segments = key.split(':');
  if (segments[0] === 'chart') {
    return `${segments[2] ?? ''}:${segments[3] ?? ''}`;
  }
  return `${segments[1] ?? ''}:${segments[2] ?? ''}`;
};

// 返回要删除的键：当前区间永不删；其余按区间起始日期降序保留前 keepRanges 组；
// 豁免清单（autocomplete/piggy_banks/bills/currencies）永不删；结果保持输入顺序。
export function selectKeysToPrune(allKeys: string[], currentRange: string, keepRanges: number): string[] {
  const deletable = allKeys.filter((key) => !NEVER_PRUNE_PREFIXES.includes(key.split(':')[0]));
  const ranges = [...new Set(deletable.map(rangeOfKey))]
    .filter((range) => range !== currentRange);
  // ISO 日期字符串按字典序即时间序；比较器按起始日期降序。
  ranges.sort((a, b) => b.split(':')[0].localeCompare(a.split(':')[0]));
  const kept = new Set([currentRange, ...ranges.slice(0, Math.max(0, keepRanges))]);
  return deletable.filter((key) => !kept.has(rangeOfKey(key)));
}

export async function readBlob<T>(db: Db, scopeId: string, key: string): Promise<Blob<T> | null> {
  // SQL 列名 fetched_at 用 AS fetchedAt 对齐 JS 驼峰命名。
  const row = await db.get<{ payload: string; fetchedAt: string }>(
    'SELECT payload, fetched_at AS fetchedAt FROM blobs WHERE scope_id = ? AND key = ?',
    [scopeId, key],
  );
  if (!row) {
    return null;
  }
  return { payload: JSON.parse(row.payload) as T, fetchedAt: row.fetchedAt };
}

export async function writeBlob(
  db: Db,
  scopeId: string,
  key: string,
  payload: unknown,
  fetchedAt: string = new Date().toISOString(),
): Promise<void> {
  await db.run(
    'INSERT OR REPLACE INTO blobs (scope_id, key, payload, fetched_at) VALUES (?, ?, ?, ?)',
    [scopeId, key, JSON.stringify(payload), fetchedAt],
  );
}

export async function getMeta(db: Db, scopeId: string, key: string): Promise<string | null> {
  const row = await db.get<{ value: string | null }>(
    'SELECT value FROM meta WHERE scope_id = ? AND key = ?',
    [scopeId, key],
  );
  return row?.value ?? null;
}

// value 为 null 时存 SQL NULL（依赖 PRIMARY KEY (scope_id, key) 做 upsert）。
export async function setMeta(db: Db, scopeId: string, key: string, value: string | null): Promise<void> {
  await db.run(
    'INSERT OR REPLACE INTO meta (scope_id, key, value) VALUES (?, ?, ?)',
    [scopeId, key, value],
  );
}

// 删除该 scope 下不在 keepKeys 的 blob 行；keepKeys 为空时清空该 scope。
export async function pruneBlobs(db: Db, scopeId: string, keepKeys: string[]): Promise<void> {
  if (keepKeys.length === 0) {
    await db.run('DELETE FROM blobs WHERE scope_id = ?', [scopeId]);
    return;
  }
  const placeholders = keepKeys.map(() => '?').join(', ');
  await db.run(
    `DELETE FROM blobs WHERE scope_id = ? AND key NOT IN (${placeholders})`,
    [scopeId, ...keepKeys],
  );
}

// ---------------------------------------------------------------------------
// 交易仓储：读（list/get）、服务端 upsert、本地删除、删除对账。
// 表结构见 schema.ts；payload 存整组 JSON，occurred_at 为首笔 split 的 date，
// server_updated_at 为组内 split 的 updated_at 最大值。

export type TransactionRecord = {
  id: string;
  payload: TransactionType;
  occurredAt: string;
  serverUpdatedAt: string | null;
  dirty: boolean;
};

export type TransactionQueryFilters = {
  start?: string;
  end?: string;
  type?: string;
  currencyCode?: string;
  account?: string;
  categoryId?: string;
  hasAnyCategory?: boolean;
  text?: string;
};

export type TransactionQuery = TransactionQueryFilters & {
  limit: number;
  offset: number;
};

// 服务端 group 的 split 带 updatedAt（本地 TransactionSplitType 未声明该字段），
// 这里用结构类型读取，避免改动模型层；TransactionType 可结构性赋值给本类型。
type ServerGroup = {
  attributes: {
    transactions: Array<{ date?: string | Date; updatedAt?: string }>;
  };
};

export function groupUpdatedAt(payload: ServerGroup): string | null {
  const splits = payload.attributes.transactions;
  if (splits.length === 0) {
    return null;
  }
  const updates = splits
    .map((split) => split.updatedAt)
    .filter((value): value is string => typeof value === 'string');
  if (updates.length === 0) {
    return null;
  }
  return updates.reduce((max, value) => (value > max ? value : max));
}

export function occurredAtOf(payload: ServerGroup): string {
  const first = payload.attributes.transactions[0];
  if (!first) {
    return '';
  }
  if (first.date instanceof Date) {
    return first.date.toISOString();
  }
  return first.date ?? '';
}

// 结构化筛选翻译成 WHERE 片段。sql 始终以 ` WHERE scope_id = ?` 开头，
// 但 scope_id 的值由调用方（listTransactions/getTransaction）前置绑定，
// 因此本函数的 params 只含筛选值。
export function buildTransactionWhere(q: TransactionQueryFilters): { sql: string; params: unknown[] } {
  const conditions: string[] = ['scope_id = ?'];
  const params: unknown[] = [];

  if (q.start !== undefined) {
    conditions.push('occurred_at >= ?');
    params.push(q.start);
  }
  if (q.end !== undefined) {
    conditions.push('occurred_at <= ?');
    params.push(q.end);
  }
  if (q.type !== undefined) {
    conditions.push("json_extract(payload, '$.attributes.transactions[0].type') = ?");
    params.push(q.type);
  }
  if (q.currencyCode !== undefined) {
    conditions.push("json_extract(payload, '$.attributes.transactions[0].currencyCode') = ?");
    params.push(q.currencyCode);
  }
  if (q.account !== undefined) {
    // 单个 LIKE 同时匹配 sourceName 与 destinationName，参数只绑定一次。
    conditions.push(
      "(json_extract(payload, '$.attributes.transactions[0].sourceName') || ' ' || json_extract(payload, '$.attributes.transactions[0].destinationName')) LIKE ?",
    );
    params.push(`%${q.account}%`);
  }
  if (q.categoryId !== undefined) {
    conditions.push("json_extract(payload, '$.attributes.transactions[0].categoryId') = ?");
    params.push(q.categoryId);
  }
  if (q.hasAnyCategory === false) {
    conditions.push("json_extract(payload, '$.attributes.transactions[0].categoryId') = ''");
  }
  if (q.text !== undefined) {
    conditions.push('payload LIKE ?');
    params.push(`%${q.text}%`);
  }

  return { sql: ` WHERE ${conditions.join(' AND ')}`, params };
}

type TransactionRow = {
  id: string;
  payload: string;
  occurred_at: string;
  server_updated_at: string | null;
  dirty: number;
};

const toRecord = (row: TransactionRow): TransactionRecord => ({
  id: row.id,
  payload: JSON.parse(row.payload) as TransactionType,
  occurredAt: row.occurred_at,
  serverUpdatedAt: row.server_updated_at,
  dirty: row.dirty === 1,
});

export async function listTransactions(db: Db, scopeId: string, q: TransactionQuery): Promise<TransactionRecord[]> {
  const { sql, params } = buildTransactionWhere(q);
  const rows = await db.all<TransactionRow>(
    `SELECT * FROM transactions${sql} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`,
    [scopeId, ...params, q.limit, q.offset],
  );
  return rows.map(toRecord);
}

export async function getTransaction(db: Db, scopeId: string, id: string): Promise<TransactionRecord | null> {
  const row = await db.get<TransactionRow>(
    'SELECT * FROM transactions WHERE scope_id = ? AND id = ?',
    [scopeId, id],
  );
  return row ? toRecord(row) : null;
}

export async function upsertServerTransactions(db: Db, scopeId: string, items: TransactionType[]): Promise<void> {
  await db.tx(async () => {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const existing = await db.get<{ dirty: number }>(
        'SELECT dirty FROM transactions WHERE scope_id = ? AND id = ?',
        [scopeId, item.id],
      );
      if (existing && existing.dirty === 1) {
        // 本地有未推送的修改，跳过以保护本地改动。
        continue;
      }
      await db.run(
        `INSERT INTO transactions (scope_id, id, payload, occurred_at, server_updated_at, dirty)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(scope_id, id) DO UPDATE SET
           payload = excluded.payload,
           occurred_at = excluded.occurred_at,
           server_updated_at = excluded.server_updated_at`,
        [scopeId, item.id, JSON.stringify(item), occurredAtOf(item), groupUpdatedAt(item)],
      );
    }
  });
}

export async function deleteLocalTransaction(db: Db, scopeId: string, id: string): Promise<void> {
  await db.run(
    'DELETE FROM transactions WHERE scope_id = ? AND id = ? AND dirty = 0',
    [scopeId, id],
  );
}

// 推送成功后用服务端响应体覆盖本地行：payload/occurred_at 以服务端为准，
// server_updated_at 作为下一次编辑的冲突基线，dirty 归零（刚推送的内容已无本地改动）。
// 调用方必须已在本地行上完成 id 绑定（bindServerId），这里按服务端 id 定位。
// server_updated_at 用 COALESCE：响应体缺少 updated_at 时保留已有基线，
// 不能把刚由 bindServerId 写好的值清空。
export async function replaceTransactionPayload(
  db: Db,
  scopeId: string,
  id: string,
  payload: TransactionType,
  serverUpdatedAt: string | null,
): Promise<void> {
  await db.run(
    `UPDATE transactions
     SET payload = ?, occurred_at = ?, server_updated_at = COALESCE(?, server_updated_at), dirty = 0
     WHERE scope_id = ? AND id = ?`,
    [JSON.stringify(payload), occurredAtOf(payload), serverUpdatedAt, scopeId, id],
  );
}

// 删除对账：完整拉取后，把该 scope 下所有 dirty=0 且不在 seenIds 中的本地交易
// 视为服务端已删除，写入 notices（server_deletion）后删除行；整个过程一个事务。
const fallbackUuid = (): string => {
  const bytes = new Uint8Array(16);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] % 16) + 0x40; // version 4
  bytes[8] = (bytes[8] % 4) + 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const randomUuid = (): string => globalThis.crypto?.randomUUID?.() ?? fallbackUuid();

// ---------------------------------------------------------------------------
// 本地保存交易：新建/编辑都先落库（dirty = 1），再入 outbox 等待推送。
// 两步必须同一事务：否则中途失败会留下「交易已改、outbox 没记」的丢失修改。

export type LocalTransactionIntent = {
  id: string;
  op: 'create' | 'update';
  baseUpdatedAt: string | null;
};

export function localTransactionId(uuid: string): string {
  return `local:${uuid}`;
}

// 缺省 id（undefined 或空串）即新建：生成 local:<uuid>，基线为 null；
// 带 id 即编辑：id 原样作为 outbox 的 entity_id，基线沿用调用方从本地记录读到的值。
export function transactionToLocal(
  payload: TransactionType,
  id: string | undefined,
  baseUpdatedAt: string | null,
): LocalTransactionIntent {
  if (!id) {
    return { id: localTransactionId(randomUuid()), op: 'create', baseUpdatedAt: null };
  }
  return { id, op: 'update', baseUpdatedAt };
}

export async function saveLocalTransaction(
  db: Db,
  scopeId: string,
  input: { id?: string; payload: TransactionType; baseUpdatedAt: string | null },
): Promise<{ id: string; op: 'create' | 'update' }> {
  const intent = transactionToLocal(input.payload, input.id, input.baseUpdatedAt);

  await db.tx(async () => {
    // 编辑时保留既有的服务端基线：INSERT OR REPLACE 会整行重写，必须先读回旧值。
    const existing = await db.get<{ server_updated_at: string | null }>(
      'SELECT server_updated_at FROM transactions WHERE scope_id = ? AND id = ?',
      [scopeId, intent.id],
    );
    await db.run(
      `INSERT OR REPLACE INTO transactions (scope_id, id, payload, occurred_at, server_updated_at, dirty)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [
        scopeId,
        intent.id,
        JSON.stringify(input.payload),
        occurredAtOf(input.payload),
        existing?.server_updated_at ?? null,
      ],
    );
    // enqueue 不自开事务，复用外层事务；同一 entity 的 create/update 合并在 outbox 内处理。
    await enqueue(db, scopeId, {
      op: intent.op,
      entityId: intent.id,
      payload: input.payload,
      baseUpdatedAt: intent.baseUpdatedAt,
    });
  });

  // 本地保存改变了 pending 计数：无论在线与否都要广播，状态条才能立刻更新。
  // 同步请求本身由调用方决定（TransactionForm 仅在线时 requestAfterSave()）。
  emitSyncChanged();

  return { id: intent.id, op: intent.op };
}

export async function reconcileDeletions(db: Db, scopeId: string, seenIds: Set<string>): Promise<number> {
  return db.tx(async () => {
    const rows = await db.all<{ id: string; payload: string }>(
      'SELECT id, payload FROM transactions WHERE scope_id = ? AND dirty = 0',
      [scopeId],
    );
    let deleted = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (seenIds.has(row.id)) {
        continue;
      }
      await db.run(
        `INSERT INTO notices (scope_id, id, kind, entity_id, local_payload, server_payload, detected_at, acknowledged_at)
         VALUES (?, ?, 'server_deletion', ?, NULL, ?, ?, NULL)`,
        [scopeId, randomUuid(), row.id, row.payload, new Date().toISOString()],
      );
      await db.run(
        'DELETE FROM transactions WHERE scope_id = ? AND id = ?',
        [scopeId, row.id],
      );
      deleted += 1;
    }
    return deleted;
  });
}

// ---------------------------------------------------------------------------
// scope 级清理：账号删除时一次性清掉该 scope 的全部本地数据。
// 判定规则独立成纯函数，便于在没有真实 SQLite 的 jest 环境验证。

export function hasLocalDataFromCounts(blobCount: number, transactionCount: number): boolean {
  return blobCount > 0 || transactionCount > 0;
}

// 只读 COUNT，不加载 payload。两张表任一有行即认为该账号有可离线展示的数据。
export async function hasLocalData(db: Db, scopeId: string): Promise<boolean> {
  const blobRow = await db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM blobs WHERE scope_id = ?',
    [scopeId],
  );
  const transactionRow = await db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM transactions WHERE scope_id = ?',
    [scopeId],
  );
  return hasLocalDataFromCounts(blobRow?.count ?? 0, transactionRow?.count ?? 0);
}

// 删除一个账号的全部本地数据：交易、blob、待推送操作、通知与分析元数据。
// 五条 DELETE 共用一次事务，避免中途失败留下半清理状态；每条都以 scope_id 为条件。
export async function deleteScope(db: Db, scopeId: string): Promise<void> {
  await db.tx(async () => {
    await db.run('DELETE FROM transactions WHERE scope_id = ?', [scopeId]);
    await db.run('DELETE FROM blobs WHERE scope_id = ?', [scopeId]);
    await db.run('DELETE FROM outbox WHERE scope_id = ?', [scopeId]);
    await db.run('DELETE FROM notices WHERE scope_id = ?', [scopeId]);
    await db.run('DELETE FROM meta WHERE scope_id = ?', [scopeId]);
  });
}
