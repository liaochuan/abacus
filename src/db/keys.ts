// blob 键必须带全维度（区间 + 币种 + 过滤开关），键名逐字对齐 spec §7.3 的 blobs 键表：
// docs/superpowers/specs/2026-10-26-offline-sync-design.md。Task 3 的 selectKeysToPrune
// 按第 2、3 段解析区间，并按 `autocomplete:*`、`piggy_banks`、`bills`、`currencies` 字面量豁免，改名即失效。

// 契约只有一个具名导出，与索引共享接口一致；默认导出会破坏 `import { blobKeys }` 的消费方。
// eslint-disable-next-line import/prefer-default-export
export const blobKeys = {
  accounts: (start: string, end: string, code: string, all: boolean): string => `accounts:${start}:${end}:${code}:${all ? 'all' : 'asset'}`,
  categories: (start: string, end: string, code: string): string => `categories:${start}:${end}:${code}`,
  budgets: (start: string, end: string, code: string): string => `budgets:${start}:${end}:${code}`,
  summary: (start: string, end: string, code: string): string => `summary:${start}:${end}:${code}`,
  chartAccounts: (start: string, end: string, code: string, all: boolean): string => `chart:accounts:${start}:${end}:${code}:${all ? 'all' : 'asset'}`,
  chartBalance: (start: string, end: string, code: string): string => `chart:balance:${start}:${end}:${code}`,
  autocomplete: (kind: 'accounts' | 'categories' | 'budgets' | 'bills' | 'tags'): string => `autocomplete:${kind}`,
  piggyBanks: (): string => 'piggy_banks',
  bills: (): string => 'bills',
  currencies: (): string => 'currencies',
};
