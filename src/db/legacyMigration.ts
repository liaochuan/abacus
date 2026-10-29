import AsyncStorage from '@react-native-async-storage/async-storage';

import { blobKeys } from './keys';
import { setMeta, writeBlob } from './repository';
import { sameBackendURL } from './scope';
import type { Db } from './types';

// 旧 @rematch/persist 存储迁移（spec §7.3 迁移一节）。旧大键 `persist:root` 的外层是
// JSON 字符串，其每个 model 属性的值仍是 JSON 字符串，需要两层解析。
// planLegacyMigration 是纯映射：不读写任何存储，输入解析后的根状态，输出待写入的 blob 计划；
// migrateLegacyState 是薄运行器：读旧键 → 解析 → 逐条 writeBlob → 全部成功后删除旧键。
// 约定：任何解析/写失败都标记 meta `migration_failed`（值 '1'）、保留旧键，并记一条不含
// payload/账户名/备注的通用日志，由设置页提示"重新初始化本地数据"（spec：迁移失败不丢旧数据）。
// 旧键没有账号维度：写库前用 legacy configuration.backendURL 与当前凭据核对，归属不符则跳过。

const LEGACY_ROOT_KEY = 'persist:root';
const MIGRATION_FAILED_META = 'migration_failed';

type MigrationEntry = { key: string; payload: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// 只接受非空字符串，其余（缺失/空串/非字符串）一律按"字段缺失"处理。
const nonEmptyString = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

// 纯映射：把旧根状态映射为 blob 键计划。返回条目顺序固定：
// firefly(summary → chart:balance) → categories → budgets → accounts → piggyBanks → bills → currencies。
// start/end 取自 firefly.rangeDetails、code 取自 currencies.currentCode；任一缺失则跳过
// 需要区间维度的键（summary/chart/categories/budgets/accounts），区间无关的键照常映射。
export function planLegacyMigration(rootState: unknown): MigrationEntry[] {
  if (!isRecord(rootState)) {
    return [];
  }
  const plan: MigrationEntry[] = [];

  const firefly = isRecord(rootState.firefly) ? rootState.firefly : null;
  const range = firefly !== null && isRecord(firefly.rangeDetails) ? firefly.rangeDetails : null;
  const start = range !== null ? nonEmptyString(range.start) : null;
  const end = range !== null ? nonEmptyString(range.end) : null;
  const currencies = isRecord(rootState.currencies) ? rootState.currencies : null;
  const code = currencies !== null ? nonEmptyString(currencies.currentCode) : null;

  if (start !== null && end !== null && code !== null) {
    if (firefly !== null) {
      plan.push({
        key: blobKeys.summary(start, end, code),
        payload: {
          netWorth: firefly.netWorth,
          spent: firefly.spent,
          earned: firefly.earned,
          balance: firefly.balance,
          bills: firefly.bills,
        },
      });
      plan.push({
        key: blobKeys.chartBalance(start, end, code),
        payload: {
          earnedChart: firefly.earnedChart,
          spentChart: firefly.spentChart,
        },
      });
    }
    if (isRecord(rootState.categories)) {
      const { categories } = rootState;
      plan.push({
        key: blobKeys.categories(start, end, code),
        payload: {
          insightCategories: categories.insightCategories,
          total: categories.total,
          perDay: categories.perDay,
        },
      });
    }
    if (isRecord(rootState.budgets)) {
      plan.push({ key: blobKeys.budgets(start, end, code), payload: rootState.budgets.budgets });
    }
    // 旧版账户列表只在资产视图消费，对齐 keys.ts 的 asset 变体。
    if (isRecord(rootState.accounts)) {
      plan.push({ key: blobKeys.accounts(start, end, code, false), payload: rootState.accounts.accounts });
    }
  }

  // 区间无关的键：模型值存在即透传整组。
  if (isRecord(rootState.piggyBanks)) {
    plan.push({ key: blobKeys.piggyBanks(), payload: rootState.piggyBanks.piggyBanks });
  }
  if (isRecord(rootState.bills)) {
    plan.push({ key: blobKeys.bills(), payload: rootState.bills.bills });
  }
  if (currencies !== null) {
    plan.push({ key: blobKeys.currencies(), payload: currencies });
  }

  return plan;
}

// 解析结果：models 是二次解析后仍成功的模型；hadParseFailure 表示是否有任一模型二次解析失败。
type ParsedLegacyRoot = {
  models: Record<string, unknown>;
  hadParseFailure: boolean;
};

// 外层 JSON.parse；每个仍是字符串的 model 值做二次 JSON.parse。个别 model 解析失败时跳过该模型
// 并置 hadParseFailure（调用方据此标记迁移失败、保留旧键），不阻塞其余模型迁移。
// 外层不可解析或非对象时返回 null，调用方按迁移失败处理。
export function parseLegacyRoot(raw: string): ParsedLegacyRoot | null {
  let outer: unknown;
  try {
    outer = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(outer)) {
    return null;
  }
  const models: Record<string, unknown> = {};
  let hadParseFailure = false;
  Object.keys(outer).forEach((model) => {
    const value = outer[model];
    if (typeof value === 'string') {
      try {
        models[model] = JSON.parse(value);
      } catch {
        hadParseFailure = true;
      }
    } else {
      models[model] = value;
    }
  });
  return { models, hadParseFailure };
}

// 标记迁移失败；连标记都写不进（DB 不可用）时保持静默，旧键不动，下次启动自然重试。
async function markMigrationFailed(db: Db, scopeId: string): Promise<void> {
  try {
    await setMeta(db, scopeId, MIGRATION_FAILED_META, '1');
  } catch {
    // 见上：失败路径无法上报，接受。
  }
}

// 跨账号防护：`persist:root` 是全局键，没有账号维度，任何已登录账号都能读到。
// 写入当前 scope 前必须确认旧数据属于这个账号：读旧 configuration.backendURL，
// 存在且与当前凭据的 backendURL 不一致（归一化后比较）就跳过迁移并保留旧键，
// 等真正的账号登录时再迁移。旧值缺失（旧版本可能没存）时保持原行为；
// 当前后端地址未知（拿不到凭据）时也无法证明归属，同样跳过。
export function legacyMigrationAllowed(
  models: Record<string, unknown>,
  expectedBackendURL: string,
): boolean {
  const configuration = isRecord(models.configuration) ? models.configuration : null;
  const legacyBackendURL = configuration !== null ? nonEmptyString(configuration.backendURL) : null;
  if (legacyBackendURL === null) {
    return true;
  }
  return expectedBackendURL !== '' && sameBackendURL(legacyBackendURL, expectedBackendURL);
}

// 薄运行器。无旧键（新装或已迁移）直接返回；旧键存在但外层不可解析按失败处理并保留旧键；
// 旧数据属于其它账号时直接跳过（不写 blob、不删旧键、不标失败）；
// 单条 writeBlob 失败记录标志并继续写其余条目；存在解析失败的模型或空计划同样按失败处理。
// 只有至少写入一条 blob 且无解析失败时才删除旧键。失败路径只记无内容通用日志
// （不含 payload/账户名/备注），失败信息由 meta `migration_failed` 承载，供设置页提示重新初始化。
export async function migrateLegacyState(
  db: Db,
  scopeId: string,
  expectedBackendURL: string,
): Promise<void> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(LEGACY_ROOT_KEY);
  } catch {
    // 存储暂时读不到不视为迁移失败，也不删旧键；下次启动重试。
    return;
  }
  if (raw === null || raw === '') {
    return;
  }

  const parsed = parseLegacyRoot(raw);
  if (parsed === null) {
    await markMigrationFailed(db, scopeId);
    return;
  }

  const { models, hadParseFailure } = parsed;

  if (!legacyMigrationAllowed(models, expectedBackendURL)) {
    // 旧数据来自另一个后端账号：不得写入当前 scope。旧键保留给它的真正主人。
    // eslint-disable-next-line no-console
    console.warn('[legacy-migration] skipped: legacy state belongs to another account');
    return;
  }

  const plan = planLegacyMigration(models);

  // 外层可解析、存在模型键却一个 blob 都产不出（无可映射模型，或全部模型解析失败）→ 迁移失败，保留旧键。
  if (plan.length === 0 && (Object.keys(models).length > 0 || hadParseFailure)) {
    await markMigrationFailed(db, scopeId);
    // eslint-disable-next-line no-console
    console.warn('[legacy-migration] no blobs could be produced from the legacy state');
    return;
  }

  let failed = false;
  for (let i = 0; i < plan.length; i += 1) {
    const entry = plan[i];
    try {
      // 逐条顺序写是有意的：同一 scope 串行落库、顺序确定（同 repository.ts 的 upsert 循环）。
      // eslint-disable-next-line no-await-in-loop
      await writeBlob(db, scopeId, entry.key, entry.payload);
    } catch {
      failed = true;
    }
  }
  if (failed || hadParseFailure) {
    await markMigrationFailed(db, scopeId);
    if (hadParseFailure) {
      // eslint-disable-next-line no-console
      console.warn('[legacy-migration] some models could not be parsed');
    }
    return;
  }
  try {
    await AsyncStorage.removeItem(LEGACY_ROOT_KEY);
  } catch {
    await markMigrationFailed(db, scopeId);
  }
}
