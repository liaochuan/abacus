import type { Db } from './types';

// scope_id：账号分区标识。名字与签名见 docs/superpowers/plans/2026-10-26-offline-sync-index.md 共享接口契约。
// 这不是加密哈希，只做本地分区键（FNV-1a 32 位双种子拼接成 16 位十六进制，等价 64 位宽度），
// 不要把任何敏感信息原样存进这一步的输入输出里。

const GLOBAL_SCOPE = '_global';
const CURRENT_SCOPE_KEY = 'current_scope';

const FNV1A_PRIME = 0x01000193;

// 按 UTF-16 code unit 迭代的 FNV-1a 32 位，seed 为 FNV 偏移基础量。
// FNV-1a 的定义就是异或 + 无符号截断乘法，位运算属于算法本身，按块豁免 no-bitwise。
/* eslint-disable no-bitwise */
const fnv1a32 = (input: string, seed: number): number => {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }
  return hash >>> 0;
};
/* eslint-enable no-bitwise */

// 归一化：trim、小写、去掉尾部 `/`，使协议/主机大小写与尾斜杠不影响分区结果。
const normalize = (value: string): string => value.trim().toLowerCase().replace(/\/+$/, '');

// 旧数据迁移要判断「旧数据来自哪个后端」，必须与分区键用同一套归一化：
// 同一账号在 `HTTPS://Host/` 与 `https://host` 下是同一个后端。
export function sameBackendURL(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

export function scopeIdFor(backendURL: string, email: string): string {
  // 用 `|` 连接两段输入，避免 'a' + 'b|c' 与 'a|b' + 'c' 这类拼接歧义（本地键，接受残余碰撞概率）。
  const material = `${normalize(backendURL)}|${normalize(email)}`;
  const first = fnv1a32(material, 0x811c9dc5).toString(16).padStart(8, '0');
  const second = fnv1a32(material, 0x050c5d1f).toString(16).padStart(8, '0');
  return `${first}${second}`;
}

// current_scope 存在 meta 的 `_global` 行里；INSERT OR REPLACE 依赖 PRIMARY KEY (scope_id, key)。
export async function setCurrentScope(db: Db, scopeId: string): Promise<void> {
  await db.run(
    'INSERT OR REPLACE INTO meta (scope_id, key, value) VALUES (?, ?, ?)',
    [GLOBAL_SCOPE, CURRENT_SCOPE_KEY, scopeId],
  );
}

// 行缺失或 value 为 NULL 时返回空串，调用方据此判断"尚未选定账号"。
export async function getCurrentScope(db: Db): Promise<string> {
  const row = await db.get<{ value: string | null }>(
    'SELECT value FROM meta WHERE scope_id = ? AND key = ?',
    [GLOBAL_SCOPE, CURRENT_SCOPE_KEY],
  );
  return row?.value ?? '';
}
