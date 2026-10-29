import type { Db } from './types';
import type { TransactionType } from '../models/transactions';

// outbox 仓储：本地意图入队、合并、回写 id、失败/重试状态。
// 表结构见 schema.ts（spec §7.3）；所有数据值一律走绑定参数。
// 状态机：pending → sent（成功，行由调用方删除）/ conflict / failed；
// failed 可经 retryOutboxItem 回到 pending。

export type OutboxOp = 'create' | 'update';
export type OutboxStatus = 'pending' | 'sent' | 'conflict' | 'failed';

export type OutboxItem = {
  id: string;
  op: OutboxOp;
  entityId: string;
  baseUpdatedAt: string | null;
  payload: TransactionType;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
};

export type OutboxIntent = {
  op: OutboxOp;
  entityId: string;
  payload: TransactionType;
  // 编辑开始时的组级 server_updated_at；新建为 null/省略。
  baseUpdatedAt?: string | null;
};

type OutboxRow = {
  scope_id: string;
  id: string;
  op: string;
  entity_id: string;
  base_updated_at: string | null;
  payload: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
};

const toItem = (row: OutboxRow): OutboxItem => ({
  id: row.id,
  op: row.op as OutboxOp,
  entityId: row.entity_id,
  baseUpdatedAt: row.base_updated_at,
  payload: JSON.parse(row.payload) as TransactionType,
  status: row.status as OutboxStatus,
  attempts: row.attempts,
  lastError: row.last_error,
  createdAt: row.created_at,
});

// uuid v4；优先用平台 crypto.randomUUID，缺失时用随机字节兜底（与 repository.ts 同策略）。
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

// 合并规则（spec §7.5）：未发送的 create 吞掉后续编辑，保持 create；
// 已有 update 保持 update 并采用最新 payload。base_updated_at 不在这里返回，
// 由 enqueue 沿用现有行（或首次入队时的入参），保证冲突检测用最初的基线。
export function mergeIntent(
  existing: OutboxItem | null,
  intent: OutboxIntent,
): { op: OutboxOp; payload: TransactionType } {
  if (!existing) {
    return { op: intent.op, payload: intent.payload };
  }
  return { op: existing.op, payload: intent.payload };
}

// 入队：同一 entity 已有 pending/failed 行时复用该行（failed 复活为 pending 并清退避状态），
// 否则插入新行。本函数**不自己开事务**：`withTransactionAsync` 不能嵌套，
// 必须由调用方（如 saveLocalTransaction）在自己的事务内调用，由调用方保证原子性。
export async function enqueue(db: Db, scopeId: string, intent: OutboxIntent): Promise<OutboxItem> {
  const row = await db.get<OutboxRow>(
    `SELECT * FROM outbox
     WHERE scope_id = ? AND entity_id = ? AND status IN (?, ?)
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [scopeId, intent.entityId, 'pending', 'failed'],
  );
  const merged = mergeIntent(row ? toItem(row) : null, intent);

  if (row) {
    const payload = JSON.stringify(merged.payload);
    if (row.status === 'failed') {
      // 用户再次编辑 failed 项：回到待推送队列，而不是留下 failed + pending 两行。
      await db.run(
        `UPDATE outbox
         SET payload = ?, status = 'pending', attempts = 0, last_error = NULL
         WHERE scope_id = ? AND id = ?`,
        [payload, scopeId, row.id],
      );
      return {
        ...toItem(row),
        payload: merged.payload,
        status: 'pending',
        attempts: 0,
        lastError: null,
      };
    }
    await db.run(
      'UPDATE outbox SET payload = ? WHERE scope_id = ? AND id = ?',
      [payload, scopeId, row.id],
    );
    return { ...toItem(row), payload: merged.payload };
  }

  const item: OutboxItem = {
    id: randomUuid(),
    op: merged.op,
    entityId: intent.entityId,
    baseUpdatedAt: intent.baseUpdatedAt ?? null,
    payload: merged.payload,
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
  };
  await db.run(
    `INSERT INTO outbox
       (scope_id, id, op, entity_id, base_updated_at, payload, status, attempts, last_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scopeId,
      item.id,
      item.op,
      item.entityId,
      item.baseUpdatedAt,
      JSON.stringify(item.payload),
      item.status,
      item.attempts,
      item.lastError,
      item.createdAt,
    ],
  );
  return item;
}

// status 省略时返回该 scope 全部行（含 sent/failed），供状态条统计使用。
// `id ASC` 作为次级排序：created_at 只到毫秒，同毫秒的行必须有确定顺序，
// 否则状态条与 push 顺序在不同查询间会漂移。
export async function listOutbox(
  db: Db,
  scopeId: string,
  status?: OutboxStatus,
): Promise<OutboxItem[]> {
  const rows = status === undefined
    ? await db.all<OutboxRow>(
      'SELECT * FROM outbox WHERE scope_id = ? ORDER BY created_at ASC, id ASC',
      [scopeId],
    )
    : await db.all<OutboxRow>(
      'SELECT * FROM outbox WHERE scope_id = ? AND status = ? ORDER BY created_at ASC, id ASC',
      [scopeId, status],
    );
  return rows.map(toItem);
}

// 失败项列表（04-T5）：只取 failed。status 过滤交给 listOutbox，避免两处各写一条 SELECT。
// scope 为空（尚未选定账号）时不查库，否则会把 `_global` 或上一个账号的失败项列出来。
export async function listIssues(db: Db, scopeId: string): Promise<OutboxItem[]> {
  if (!scopeId) {
    return [];
  }
  return listOutbox(db, scopeId, 'failed');
}

// 失败原因 → 词条 key。last_error 只存固定分类（HTTP 状态码 / network / server），
// 这里把分类映射成用户能理解的说明；未知值回落到通用的「需处理」，
// 绝不把原始错误串直接展示给用户。
export function issueLabel(item: OutboxItem): string {
  switch (item.lastError) {
    case '422':
    case '409':
      return 'transaction_needs_fix';
    case '404':
      return 'transaction_gone_on_server';
    case 'network':
      return 'transaction_waiting_network';
    default:
      return 'sync_status_problems';
  }
}

// 两个可选参数合并成 opts，便于调用方按需补充：
// - serverUpdatedAt：响应体的组级 updated_at，写进 server_updated_at 作为冲突基线；
// - keepOutboxId：调用方正在处理的那条 outbox 行，绑定后必须保留它（调用方随后按 id 删除）。
export type BindServerIdOptions = {
  serverUpdatedAt?: string | null;
  keepOutboxId?: string;
};

// POST 成功后把本地临时 id 换成服务端 id：交易行去脏并记录冲突基线，pending outbox 行改挂新 entity_id。
// 先确认本地行仍存在：重放（上一次已改名成功、响应丢失后重试）时本地 local:<uuid> 已不存在，
// 此时必须整体 no-op，否则预删除会把刚写好的服务端行删掉，交易凭空消失。
// 本地行存在时，先删掉本地已存在的同名服务端行（例如 pull 抢先写入），再改名；
// `id <> ?` 守卫保证 localId === serverId 时不会误删本地行。
// serverUpdatedAt 是响应体的组级 updated_at，必须写进 server_updated_at（COALESCE，
// 未提供时保留旧值），否则离线新建的交易永远没有冲突基线。
// 同一 entity 在 outbox 可能有历史遗留的多行：只保留 keepOutboxId 指定的那一行
// （调用方正在推送的意图），其余 pending/failed 行删除，避免它们继续指向失效的 local id；
// 未提供 keepOutboxId 时退化为保留最早一行，保持旧调用方的行为。
// 三步必须同事务，否则中途失败会留下「交易已换 id、outbox 还指向 local:」的孤儿。
export async function bindServerId(
  db: Db,
  scopeId: string,
  localId: string,
  serverId: string,
  opts: BindServerIdOptions = {},
): Promise<void> {
  const { serverUpdatedAt = null, keepOutboxId } = opts;
  await db.tx(async () => {
    const local = await db.get<{ one: number }>(
      'SELECT 1 AS one FROM transactions WHERE scope_id = ? AND id = ?',
      [scopeId, localId],
    );
    if (!local) {
      return;
    }
    await db.run(
      'DELETE FROM transactions WHERE scope_id = ? AND id = ? AND id <> ?',
      [scopeId, serverId, localId],
    );
    await db.run(
      `UPDATE transactions SET id = ?, dirty = 0, server_updated_at = COALESCE(?, server_updated_at)
       WHERE scope_id = ? AND id = ?`,
      [serverId, serverUpdatedAt ?? null, scopeId, localId],
    );
    const rows = await db.all<{ id: string }>(
      `SELECT id FROM outbox
       WHERE scope_id = ? AND entity_id = ? AND status IN ('pending', 'failed')
       ORDER BY created_at ASC, id ASC`,
      [scopeId, localId],
    );
    if (rows.length === 0) {
      return;
    }
    // keepOutboxId 可能已被并发删除或状态变为 conflict：此时退回最早一行，保证总有行被改挂。
    const keepId = keepOutboxId && rows.some((row) => row.id === keepOutboxId)
      ? keepOutboxId
      : rows[0].id;
    await db.run(
      `DELETE FROM outbox
       WHERE scope_id = ? AND entity_id = ? AND status IN ('pending', 'failed') AND id <> ?`,
      [scopeId, localId, keepId],
    );
    await db.run(
      'UPDATE outbox SET entity_id = ? WHERE scope_id = ? AND id = ?',
      [serverId, scopeId, keepId],
    );
  });
}

// outbox.id 是全局唯一的 uuid 主键，故这三个按 id 定位的函数不需要 scope_id
// （调用方从 listOutbox 拿到的行本身已按 scope 过滤）。
export async function removeOutboxItem(db: Db, id: string): Promise<void> {
  await db.run('DELETE FROM outbox WHERE id = ?', [id]);
}

export async function markOutboxFailed(db: Db, id: string, error: string): Promise<void> {
  await db.run(
    "UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?",
    [error, id],
  );
}

// 可重试失败的尝试上限：attempts 达到该值时不再退避重放，直接转 failed 交给用户处理
// （spec §7.5「网络错误 / 5xx → 保留 pending 并退避」，但无限重放会让状态条永远显示待上传）。
export const MAX_OUTBOX_ATTEMPTS = 5;

// 可重试失败（network / server）的记账：attempts += 1、写入分类，状态**保持 pending**，
// 由下一轮同步继续重试。与 markOutboxFailed 的区别只有状态。
// 这是新增语句，按项目硬规则带 scope_id 过滤；last_error 只存错误分类（network / server / 状态码），
// 不含 payload、token、账户名或备注。
export async function recordOutboxAttempt(
  db: Db,
  scopeId: string,
  id: string,
  error: string,
): Promise<void> {
  await db.run(
    'UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE scope_id = ? AND id = ?',
    [error, scopeId, id],
  );
}

// 用户点「重试」：状态回到 pending 并清空退避计数与错误，payload 保持本地最新版本。
export async function retryOutboxItem(db: Db, id: string): Promise<void> {
  await db.run(
    "UPDATE outbox SET status = 'pending', attempts = 0, last_error = NULL WHERE id = ?",
    [id],
  );
}

// 用户点「放弃本地改动」：同事务删掉这条失败意图，并处理对应的本地交易行。
// - `local:` 前缀 = 只在本地新建、服务端还没有：删除该 entity 的**全部** outbox 行，
//   不能只删 item.id —— 同一 local id 可能残留多条（pending / conflict 等），
//   留着它们会在下一轮重放时指向已被删除的交易；交易行也一并删除，
//   否则会留下一条永远推不上去、也删不掉的幽灵交易；
// - 服务端已有的交易：保留本地副本（用户的日期/金额等数据不丢），只把 dirty 清 0，
//   让下一轮 pull 可以正常覆盖它。
// 交易行的删除/去脏不能复用 deleteLocalTransaction：它只删 dirty = 0 的行，
// 而本地新建的行是 dirty = 1，会被静默跳过。
// 所有语句都按 scope_id 过滤：outbox.id 虽全局唯一，但调用方传入的 item 可能来自旧 scope。
export async function dropOutboxItem(
  db: Db,
  scopeId: string,
  item: OutboxItem,
): Promise<void> {
  await db.tx(async () => {
    if (item.entityId.startsWith('local:')) {
      await db.run(
        'DELETE FROM outbox WHERE scope_id = ? AND entity_id = ?',
        [scopeId, item.entityId],
      );
      await db.run(
        'DELETE FROM transactions WHERE scope_id = ? AND id = ?',
        [scopeId, item.entityId],
      );
      return;
    }
    await db.run('DELETE FROM outbox WHERE scope_id = ? AND id = ?', [scopeId, item.id]);
    await db.run(
      'UPDATE transactions SET dirty = 0 WHERE scope_id = ? AND id = ?',
      [scopeId, item.entityId],
    );
  });
}
