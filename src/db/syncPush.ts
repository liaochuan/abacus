import type { AxiosInstance, AxiosResponse } from 'axios';
import type { Db } from './types';
import type { OutboxItem } from './outbox';
import type { TransactionSplitType, TransactionType } from '../models/transactions';
import { convertKeysToCamelCase } from '../lib/case';
import { bindServerId, markOutboxFailed, removeOutboxItem } from './outbox';
import { groupUpdatedAt, replaceTransactionPayload } from './repository';
import { classifySyncError } from './syncErrors';
import { pickDuplicateGroup } from './syncWindows';

// 推送：把 outbox 里的本地意图转成 Firefly API 请求。
// 本文件不主动重试、不处理 token（由调用方 runSync 的退避与 withAuthRetry 负责），
// 只负责「发一次请求 + 幂等对账 + 落库回写」。日志与错误信息中不得出现 payload、token、
// 账户名或备注：本文件也不打日志。

// push 只依赖后端地址与 http 客户端。完整 SyncContext（src/db/sync.ts）是本类型的超集，
// 因此 runSync 组装出的上下文可以结构化赋值进来。
export type SyncPushContext = {
  backendURL: string;
  http: AxiosInstance;
};

export type PushCreateResult = 'created' | 'duplicate' | 'failed';

export type PushUpdateResult = 'updated' | 'conflict' | 'failed';

// 服务端**已经接受**这笔改动（POST/PUT 2xx，或 push 前对账命中唯一重复组）之后，
// 本地写库（绑定 id / 回写 payload / 删 outbox 行）失败。
// 这一类错误必须让 outbox 行留在 pending：服务端已经存在这笔交易，标 failed 会停止重试，
// 交易就成了孤儿。消息是固定的、无内容的短句（不含 SQL、payload、id 或底层错误文本），
// 底层错误只挂在 cause 上供排查。
export class LocalWriteError extends Error {
  constructor(cause?: unknown) {
    super('local write failed after server accepted the change');
    this.name = 'LocalWriteError';
    if (cause !== undefined) {
      // 部分编译目标/运行时的 Error 不带 cause 支持，按可选属性写入即可。
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

// 把「2xx 之后的本地写库步骤」包成 LocalWriteError，让调用方能把它们与网络/业务错误区分开。
// 已经是 LocalWriteError 的原样透传，避免重复包装丢失原始 cause。
async function writeLocalState(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    throw error instanceof LocalWriteError ? error : new LocalWriteError(error);
  }
}

// 通知（notices）由 push update 的冲突检测写入，04 的「需处理」列表消费。
export type NoticeKind = 'conflict' | 'server_deletion';

export type NoticeInput = {
  kind: NoticeKind;
  entityId: string;
  // conflict 时的本地版本；server_deletion 时为 undefined（落库为 NULL）。
  localPayload?: string;
  serverPayload: string;
};

// Firefly III POST/PUT /api/v1/transactions 的请求体。
// id 类字段为空时置 undefined：JSON.stringify 会直接省略该键，
// 避免把空串发给服务端当成非法 id。
export type TransactionBodySplit = {
  description: string;
  amount: number;
  date: string | Date;
  type: string;
  source_name: string;
  source_id?: number;
  destination_name: string;
  destination_id?: number;
  category_name: string;
  category_id?: string;
  budget_name: string;
  budget_id?: string;
  bill_id?: string;
  bill_name: string;
  tags: string[];
  notes: string;
  foreign_amount: number | null;
  foreign_currency_id?: string;
};

export type TransactionBody = {
  group_title: string;
  transactions: TransactionBodySplit[];
  error_if_duplicate_hash: false;
};

// 金额在模型里是字符串，可能带逗号小数（如 '3,50'）。空值按字段语义落默认值：
// amount 缺省为 0，foreign_amount 缺省为 null（表示不涉及外币）。
// 无法解析的值同样落到默认值，避免把 NaN 序列化成 null 混进 amount。
function normalizeAmount(value: unknown, empty: number): number;
function normalizeAmount(value: unknown, empty: null): number | null;
function normalizeAmount(value: unknown, empty: number | null): number | null {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (normalized === '') {
    return empty;
  }
  const parsed = parseFloat(normalized);
  return Number.isNaN(parsed) ? empty : parsed;
}

// 空串/缺失的 id 视为「未选择」，返回 undefined 让 JSON 省略该键。
const optionalId = <T>(value: T | '' | null | undefined): T | undefined => (
  value === '' || value === null || value === undefined ? undefined : value
);

export function buildTransactionBody(payload: TransactionType): TransactionBody {
  const attributes = payload?.attributes;
  const splits = attributes?.transactions ?? [];
  return {
    group_title: attributes?.groupTitle ?? '',
    transactions: splits.map((split: TransactionSplitType) => ({
      description: split.description,
      amount: normalizeAmount(split.amount, 0),
      date: split.date,
      type: split.type,
      source_name: split.sourceName,
      source_id: optionalId(split.sourceId),
      destination_name: split.destinationName,
      destination_id: optionalId(split.destinationId),
      category_name: split.categoryName,
      category_id: optionalId(split.categoryId),
      budget_name: split.budgetName,
      budget_id: optionalId(split.budgetId),
      bill_id: optionalId(split.billId),
      bill_name: split.billName,
      tags: split.tags,
      notes: split.notes,
      foreign_amount: normalizeAmount(split.foreignAmount, null),
      foreign_currency_id: optionalId(split.foreignCurrencyId),
    })),
    error_if_duplicate_hash: false,
  };
}

// 服务端组的组级 updated_at。响应结构异常时退化为 null，
// 而不是让 groupUpdatedAt 抛 TypeError 被误判成网络错误。
function serverUpdatedAtOf(payload: TransactionType | null | undefined): string | null {
  const splits = payload?.attributes?.transactions;
  if (!Array.isArray(splits)) {
    return null;
  }
  return groupUpdatedAt({ attributes: { transactions: splits } });
}

// Firefly 原始响应是 snake_case（group_title / updated_at / source_name…），
// 而本地模型与 SQL 全部按 camelCase 读写。ctx.http 的拦截器是否做过转换不属于本层能假设的事，
// 因此每个响应体在这里统一归一化一次（对已是 camelCase 的对象是幂等的）。
function normalizeTransaction(payload: unknown): TransactionType | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  return convertKeysToCamelCase(payload) as TransactionType;
}

// uuid v4；与 outbox.ts / repository.ts 同策略（平台 crypto 优先，缺失时用随机字节兜底），
// 这样 notices 的 id 在 jest 的 jsdom 环境下同样可用。
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

// 冲突判定：服务端组级 updated_at 是否晚于本地编辑开始时的基线。
// - server 为 null：服务端没给出可比较的更新时间，没有「更新」的证据 → 不记冲突；
// - base 为 null：本地编辑开始时没有基线（离线新建后又编辑，或服务端从未返回 updated_at）。
//   这是「基线未知」而非「服务端未变」——按裁定当作可能已被改动，记一条冲突提示；
//   但仍用本地版本覆盖服务端（本地优先，用户在离线期间的编辑不丢）；
// - 两者都有值：Firefly 的 updated_at 是 UTC ISO8601，字典序即时间序，直接比较。
export function isServerNewer(server: string | null, base: string | null): boolean {
  if (server === null) {
    return false;
  }
  if (base === null) {
    return true;
  }
  return server > base;
}

// 写一条待处理通知。acknowledged_at 留 NULL，由 04 的「已读」操作回填。
// 幂等：同一 (scope, entity, kind) 已有未确认通知时就地刷新内容与时间，不新增行。
// 重试的 update 会再次看到「服务端更晚」（上一次 PUT 没落地），若每次插入新行，
// 「需处理」列表会被同一条冲突刷屏。已确认的旧通知不参与复用，用户读过之后再冲突是新事件。
// 所有值走绑定参数，两条语句都带 scope_id。
export async function writeNotice(db: Db, scopeId: string, input: NoticeInput): Promise<void> {
  const existing = await db.get<{ id: string }>(
    `SELECT id FROM notices
     WHERE scope_id = ? AND entity_id = ? AND kind = ? AND acknowledged_at IS NULL
     ORDER BY detected_at DESC, id ASC
     LIMIT 1`,
    [scopeId, input.entityId, input.kind],
  );
  const detectedAt = new Date().toISOString();
  if (existing) {
    await db.run(
      'UPDATE notices SET local_payload = ?, server_payload = ?, detected_at = ? WHERE id = ?',
      [input.localPayload ?? null, input.serverPayload, detectedAt, existing.id],
    );
    return;
  }
  await db.run(
    `INSERT INTO notices
       (scope_id, id, kind, entity_id, local_payload, server_payload, detected_at, acknowledged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      scopeId,
      randomUuid(),
      input.kind,
      input.entityId,
      input.localPayload ?? null,
      input.serverPayload,
      detectedAt,
    ],
  );
}

// 对账：POST 之前总会先按组标题搜索一次（首次推送与重试都一样），因为上一次尝试可能
// 已经被服务端接受但响应丢失，或 POST 成功后本地写库失败；这些情况下重发会造出重复组。
// 只认整组一致且唯一匹配（pickDuplicateGroup），notBefore 用本地入队时间，
// 避免绑定到更早就存在的另一笔相似交易。
async function findServerDuplicate(
  ctx: SyncPushContext,
  item: OutboxItem,
): Promise<TransactionType | null> {
  const groupTitle = item.payload?.attributes?.groupTitle ?? '';
  const query = encodeURIComponent(groupTitle);
  const response = await ctx.http.get(
    `${ctx.backendURL}/api/v1/search/transactions?limit=20&query=${query}`,
  );
  const candidates = response?.data?.data;
  if (!Array.isArray(candidates)) {
    return null;
  }
  return pickDuplicateGroup(
    convertKeysToCamelCase(candidates) as TransactionType[],
    item.payload,
    item.createdAt,
  );
}

// 推送一条 create：
// - POST 之前先对账：上一次 POST 可能已经被服务端接受（响应丢失，或 POST 成功后本地写库失败，
//   后者不会累加 attempts，所以这里不能按 attempts 判断），此时直接重发会造出重复组；
//   命中唯一重复项 → 绑定并删行 → 'duplicate'，只有查不到才真正 POST；
// - 成功 → 绑定服务端 id → 用响应体回写本地行 → 删除 outbox 行 → 'created'；
// - network/server 失败 → 再对账一次（覆盖「本次 POST 已到达服务端但响应丢失」），
//   命中唯一重复项则绑定并删行 → 'duplicate'，未命中则把原错误抛给调用方
//   （由 runSync 计入 failed 并走退避）；
// - auth 失败 → 原样上抛且**不**改 outbox 行，交给 withAuthRetry 刷新 token 后整轮重跑
//   （标 failed 会让刷新成功也不再重试）；
// - 其余（gone/invalid/other）→ 标记 outbox 行 failed → 'failed'。
// 本函数只做「一次尝试 + 幂等对账」，attempts / 退避 / 认证重试全部由 runSync 负责。
// 关键边界：POST 一旦返回 2xx，服务端就已经接受了这笔交易。此后任何本地写库失败
// （绑定/回写/删行）都必须以 LocalWriteError 抛出且**不**标记 failed——否则 outbox 停止重试，
// 服务端那笔交易会变成孤儿，日后用户重录还会叠加重复。runSync 据此只累加 attempts 并保持 pending。
// 代价：每笔新建多一次 search GET。create 本身低频，且这是唯一能封住重复窗口的地方。
export async function pushCreate(
  db: Db,
  scopeId: string,
  ctx: SyncPushContext,
  item: OutboxItem,
): Promise<PushCreateResult> {
  if (item.op === 'create') {
    // 对账请求自身失败时直接向上抛：宁可下轮再试，也不在无法确认的前提下再 POST 一次。
    const existing = await findServerDuplicate(ctx, item);
    if (existing) {
      await writeLocalState(async () => {
        await bindServerId(db, scopeId, item.entityId, existing.id, {
          serverUpdatedAt: serverUpdatedAtOf(existing),
          keepOutboxId: item.id,
        });
        await removeOutboxItem(db, item.id);
      });
      return 'duplicate';
    }
  }

  let response: AxiosResponse | undefined;
  try {
    response = await ctx.http.post(
      `${ctx.backendURL}/api/v1/transactions`,
      buildTransactionBody(item.payload),
    );
  } catch (error) {
    const kind = classifySyncError(error);
    if (kind === 'network' || kind === 'server') {
      let duplicate: TransactionType | null = null;
      try {
        duplicate = await findServerDuplicate(ctx, item);
      } catch {
        duplicate = null;
      }
      if (duplicate) {
        await writeLocalState(async () => {
          await bindServerId(db, scopeId, item.entityId, duplicate.id, {
            serverUpdatedAt: serverUpdatedAtOf(duplicate),
            keepOutboxId: item.id,
          });
          await removeOutboxItem(db, item.id);
        });
        return 'duplicate';
      }
      throw error;
    }
    if (kind === 'auth') {
      // 认证失败不碰 outbox 行：runSync 会把它抛给 withAuthRetry，刷新 token 后整轮重跑。
      throw error;
    }
    await markOutboxFailed(db, item.id, kind);
    return 'failed';
  }

  // 以下都在 2xx 之后执行：失败只向上抛，绝不改 outbox 状态（见上方说明）。
  const created = normalizeTransaction(response?.data?.data);
  if (!created?.id) {
    // 2xx 表示服务端已经接受这笔交易，但响应无法落库（缺 id / 结构不可用）。
    // 与本地写库失败同类：必须保持 pending 让下一轮对账接住，因此按 LocalWriteError 抛出，
    // 具体原因只挂在 cause 上（消息保持固定短句）。
    throw new LocalWriteError(new Error('transaction create response missing id'));
  }
  const serverUpdatedAt = serverUpdatedAtOf(created);
  await writeLocalState(async () => {
    await bindServerId(db, scopeId, item.entityId, created.id, {
      serverUpdatedAt,
      keepOutboxId: item.id,
    });
    await replaceTransactionPayload(db, scopeId, created.id, created, serverUpdatedAt);
    await removeOutboxItem(db, item.id);
  });
  return 'created';
}

// 推送一条 update（PUT 整组覆盖）：
// - 先 GET 服务端当前版本，拿组级 updated_at 与本地的 base_updated_at 比较；
// - 服务端更晚（或基线未知，见 isServerNewer）→ 写一条 conflict 通知，把本地版本与服务端版本
//   都序列化进 notices 供用户在「需处理」里比较；随后**仍然** PUT：本地优先，离线编辑不丢；
// - PUT 成功 → 用响应体回写本地行（dirty 归零、刷新冲突基线）→ 删除 outbox 行 →
//   有冲突返回 'conflict'，否则 'updated'；
// - GET 404：服务端已删除这笔交易，PUT 必然 404 → 直接标记 failed（last_error='404'）；
// - GET 其他错误（网络/5xx/auth）：基线无法确认，原样抛给 runSync 计入失败并退避重试，
//   不改 outbox 状态（与 pushCreate 的处理一致）；
// - PUT 的 network / server / auth 失败 → 同样原样上抛且不改 outbox 行：attempts 与退避由
//   runSync 统一记账，auth 更要让 withAuthRetry 看到（否则刷新 token 后也不会重试）；
// - PUT 的 gone / invalid / other 失败 → 标记 failed 并返回 'failed'，重放只会再失败一次，
//   把决定权交回用户（04 的重试入口）比后台反复盲写更安全。
// 2xx 之后若响应体缺失，仍用本地 payload 回写：刚 PUT 的内容就是服务端内容，
// 不能因为响应体为空让 outbox 行停在这里反复重放；但此时**不**推导基线（传 null，
// 交给 replaceTransactionPayload 的 COALESCE 保留旧值）——本地 split 的 updated_at
// 是上次 pull 的陈旧值，拿来当基线会让下一轮把服务端误判成「更新过」。
// 若响应体存在但不可用（缺 id），按 LocalWriteError 抛出并保持 pending。
export async function pushUpdate(
  db: Db,
  scopeId: string,
  ctx: SyncPushContext,
  item: OutboxItem,
): Promise<PushUpdateResult> {
  if (item.op !== 'update') {
    throw new Error('pushUpdate received a non-update item');
  }

  const url = `${ctx.backendURL}/api/v1/transactions/${encodeURIComponent(item.entityId)}`;

  let conflict = false;
  try {
    const current = await ctx.http.get(url);
    const serverPayload = normalizeTransaction(current?.data?.data);
    if (serverPayload && isServerNewer(serverUpdatedAtOf(serverPayload), item.baseUpdatedAt)) {
      await writeNotice(db, scopeId, {
        kind: 'conflict',
        entityId: item.entityId,
        localPayload: JSON.stringify(item.payload),
        serverPayload: JSON.stringify(serverPayload),
      });
      conflict = true;
    }
  } catch (error) {
    if (classifySyncError(error) === 'gone') {
      await markOutboxFailed(db, item.id, '404');
      return 'failed';
    }
    throw error;
  }

  let response: AxiosResponse | undefined;
  try {
    response = await ctx.http.put(url, buildTransactionBody(item.payload));
  } catch (error) {
    const kind = classifySyncError(error);
    if (kind === 'auth' || kind === 'network' || kind === 'server') {
      // 可重试 / 需刷新 token：不动 outbox 行，交给 runSync（attempts + 退避 / withAuthRetry）。
      throw error;
    }
    await markOutboxFailed(db, item.id, kind === 'gone' ? '404' : kind);
    return 'failed';
  }

  const updated = normalizeTransaction(response?.data?.data);
  if (updated && !updated.id) {
    // 2xx 但响应体不可用：与「本地写库失败」同等对待，保持 pending 让下一轮重放 PUT。
    throw new LocalWriteError(new Error('transaction update response missing id'));
  }
  const payload = updated ?? item.payload;
  const serverUpdatedAt = updated ? serverUpdatedAtOf(updated) : null;
  await writeLocalState(async () => {
    await replaceTransactionPayload(db, scopeId, item.entityId, payload, serverUpdatedAt);
    await removeOutboxItem(db, item.id);
  });
  return conflict ? 'conflict' : 'updated';
}
