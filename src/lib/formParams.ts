import type { TransactionRecord } from '../db/repository';
import type { TransactionSplitType } from '../models/transactions';

// 详情页把本地记录转换成 TransactionForm 的入参。
// baseUpdatedAt 取本地保存的服务端基线，由表单原样传给 saveLocalTransaction；
// 服务端从未同步过的记录（serverUpdatedAt 为 null）基线也是 null。
export type TransactionFormParams = {
  id: string;
  baseUpdatedAt: string | null;
  groupTitle: string;
  splits: TransactionSplitType[];
};

// payload 来自本地 JSON 列，解析结果可能畸形（null、attributes 缺失、transactions 非数组）。
// 这里只做结构判定，不信任任何字段。
const attributesOf = (record: TransactionRecord): Partial<TransactionRecord['payload']['attributes']> => {
  const payload = record.payload as TransactionRecord['payload'] | null | undefined;
  const attributes = payload?.attributes;
  if (!attributes || typeof attributes !== 'object') {
    return {};
  }
  return attributes;
};

// 只有「有 id 且至少有一条 split」的记录才能安全编辑：否则空表单提交会把原交易清空。
export function isUsableRecord(record: TransactionRecord | null | undefined): boolean {
  if (!record || !record.id) {
    return false;
  }
  const attributes = attributesOf(record);
  return Array.isArray(attributes.transactions) && attributes.transactions.length > 0;
}

export function toFormParams(record: TransactionRecord): TransactionFormParams {
  const attributes = attributesOf(record);
  return {
    id: record.id,
    baseUpdatedAt: record.serverUpdatedAt ?? null,
    groupTitle: attributes.groupTitle ?? '',
    splits: Array.isArray(attributes.transactions) ? attributes.transactions : [],
  };
}
