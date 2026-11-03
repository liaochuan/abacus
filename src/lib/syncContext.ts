import axios from 'axios';

import type { SyncContext } from '../db/sync';
import { readCachedCurrentCode } from '../db/cachedCurrencies';
import { getDb } from '../db/instance';
import { getCurrentScope, scopeIdFor } from '../db/scope';
import { classifySyncError } from '../db/syncErrors';
import { buildCurrenciesBlob } from '../db/syncBlobs';
import { computePullWindow } from '../db/syncWindows';
import type { TCredential } from '../types/credential';
import { store } from '../store';
import { getCredentials } from './oauth';

// 同步上下文的组装层：把 Redux 的 configuration/firefly/currencies 与 SecureStore 里的
// credential 拼成 runSync 需要的 SyncContext。
//
// 关键约束（见 sync.ts 的契约注释）：http 必须是**同一个** axios 实例，token 在每次请求时
// 从模块级 activeContext 读取。这样 withAuthRetry 刷新 token 后只需替换 activeContext.accessToken，
// 不必重建实例；把 token 固化进 defaults.headers 会让刷新后的重试继续发旧 token 并再次 401。
//
// 本文件不打日志、不返回凭证内容给 UI：token 只在模块内流转。

type Credential = TCredential;

type TokenHolder = { accessToken: string };

// 当前活动上下文的 token 持有者。同一时刻只有一个同步在跑（runExclusively 单飞），
// 因此不需要按 scope 区分；每次 buildSyncContext 都会覆盖它。
let activeContext: TokenHolder | null = null;

// 固定超时：单飞锁与定时链都依赖 requestSync 最终返回，挂起的请求必须自己失败，
// 否则后续所有触发都会被 isSyncRunning 挡掉。
const http = axios.create({ timeout: 30_000 });

// 每次请求都读「此刻」的 token：刷新后 activeContext.accessToken 变了，重试自动带上新 token。
http.interceptors.request.use((config) => {
  const token = activeContext?.accessToken;
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

// 账号与分区必须一一对应：凭据按 scopeIdFor(backendURL, email) 精确匹配 current_scope，
// 绝不使用 isDefault / 第一条兜底（多账号下会把 A 的 token 用于写 B 的分区）。
// 只有「当前只有一个凭据」时才容忍 scope 不一致（例如迁移前的旧 scope 键）。
function pickCredential(credentials: Credential[], scopeId: string): Credential | null {
  const matching = credentials.find(
    (c) => scopeIdFor(c.backendURL, c.email) === scopeId,
  );
  if (matching) {
    return matching;
  }
  return credentials.length === 1 ? credentials[0] : null;
}

function sameAccount(a: Credential, b: Credential): boolean {
  return a.email === b.email && a.backendURL === b.backendURL;
}

// 刷新 token：复用现有 firefly effect（它负责 OAuth 刷新、写回 SecureStore 并更新全局 header；
// 全局 header 的写入在下面被快照/恢复，本函数只改 activeContext）。
// 返回值必须是**SecureStore 里的新 token**（effect 本身返回 void）：重新读一遍凭据，
// 而不是信任内存里的旧对象。刷新失败（refresh 被拒 / 网络错误）原样抛出，
// 由 withAuthRetry 决定是「下轮再试」还是 AuthExpiredError。
async function refreshAccessToken(credential: Credential): Promise<string> {
  // firefly.getFreshAccessToken 会把新 token 写进全局 axios 默认头（历史行为，登录页依赖它）。
  // 同步请求自己的 token 走 activeContext + http 拦截器，不读这个默认头；这里必须把默认头
  // 恢复到调用前的样子，否则账号切换时会把旧账号的 token 留在共享 axios 上（token 串号）。
  const previousAuthorization = axios.defaults.headers.Authorization;
  try {
    await store.dispatch.firefly.getFreshAccessToken(credential);
  } finally {
    if (previousAuthorization === undefined) {
      delete axios.defaults.headers.Authorization;
    } else {
      axios.defaults.headers.Authorization = previousAuthorization;
    }
  }

  const credentials = (await getCredentials()) as Credential[];
  const fresh = credentials.find((c) => sameAccount(c, credential));
  if (!fresh?.accessToken) {
    // 固定的短句：不能带邮箱/后端地址/token。
    throw new Error('token refresh produced no credential');
  }

  if (activeContext) {
    activeContext.accessToken = fresh.accessToken;
  }
  return fresh.accessToken;
}

// 拉取默认币种：复用同步自己的 http（带 30 秒超时），Authorization 由 activeContext
// 拦截器注入；不走全局 axios 默认头——冷启动不保证存在，且可能是上一个账号的 token。
async function fetchDefaultCurrency(backendURL: string): Promise<string> {
  const response = await http.get(`${backendURL}/api/v1/currencies`);
  return buildCurrenciesBlob(response?.data, '').currentCode;
}

async function readCachedCurrencyCode(scopeId: string): Promise<string | null> {
  try {
    return await readCachedCurrentCode(getDb(), scopeId);
  } catch {
    return null;
  }
}

/**
 * 取得本轮同步可用的币种与最终 token。
 *
 * - 已有值（persist / getCurrencies / cachedCurrentCode）直接用；
 * - 为空时先用本轮账号自己的 token 拉一次默认币种，token 过期则刷新后重试；
 * - 刷新/重试失败、网络或服务端故障、服务端没有默认币种时，回落当前 scope 的
 *   currencies 缓存，至少让 outbox 推送与旧 blob 继续可用；都没有才抛错，让状态条
 *   显示失败而不是静默停在 idle。
 *
 * 返回值里的 accessToken 是刷新后的最新 token：调用方必须用它组装 SyncContext，
 * 否则刷新结果会被旧 credential 覆盖，runSync 第一发请求又要再刷新一次。
 *
 * 本函数自身不写 Redux；调用方在确认 scope 未变后，负责把空币种补回
 * `currencies.currentCode`，避免首页按空键读数据。
 */
async function resolveCurrencyCode(
  currentCode: string,
  backendURL: string,
  scopeId: string,
  credential: Credential,
): Promise<{ currencyCode: string; accessToken: string }> {
  if (currentCode) {
    return { currencyCode: currentCode, accessToken: credential.accessToken };
  }

  // activeContext 只影响本文件创建的 http 实例，请求结束后的 runSync 会再次覆盖它。
  // 用局部引用读取刷新后的 token，避免 activeContext 被后续流程替换后拿错。
  const tokenHolder: TokenHolder = { accessToken: credential.accessToken };
  activeContext = tokenHolder;

  let fetched = '';
  let probeError: unknown = null;
  try {
    fetched = await fetchDefaultCurrency(backendURL);
  } catch (error) {
    if (classifySyncError(error) === 'auth') {
      // 与 runSync 一致：token 过期先刷新一次再重试。
      // 刷新或重试的失败都走下面的缓存兜底，不能绕过 readCachedCurrencyCode。
      try {
        await refreshAccessToken(credential);
        fetched = await fetchDefaultCurrency(backendURL);
      } catch (retryError) {
        probeError = retryError;
      }
    } else {
      probeError = error;
    }
  }

  if (fetched) {
    return { currencyCode: fetched, accessToken: tokenHolder.accessToken };
  }

  const cached = await readCachedCurrencyCode(scopeId);
  if (cached) {
    return { currencyCode: cached, accessToken: tokenHolder.accessToken };
  }
  if (probeError) {
    throw probeError;
  }
  throw new Error('sync currency unavailable');
}

/**
 * 组装一轮同步的上下文。
 *
 * scopeId 由调用方（requestSync）只读一次后传入，本函数不再自行读 current_scope：
 * 两处各读一次会在 await 之间出现「用 A 的凭据 + B 的分区」的窗口。
 *
 * 返回 null 表示「没有可同步的账号」：scopeId 为空、没有匹配该 scope 的 credential，
 * 或 credential 尚未拿到 accessToken。调用方应回到 idle，而不是报错。
 * 币种无法取得时抛错（不是返回 null）：此时有账号但不能安全地写 blobs，必须让状态条
 * 显示失败，不能伪装成「已同步」。
 */
export async function buildSyncContext(scopeId: string): Promise<SyncContext | null> {
  if (!scopeId) {
    return null;
  }

  const credentials = (await getCredentials()) as Credential[];
  const credential = pickCredential(credentials, scopeId);
  if (!credential || !credential.accessToken) {
    return null;
  }

  const state = store.getState();
  const configuration = state.configuration;
  // currentCode 的来源不止 HomeScreen：Redux persist、登录后的 getCurrencies、
  // 以及离线兜底的 cachedCurrentCode 都可能写入。首次安装或刚登录时仍可能为空串，
  // 用空币种组装上下文会把 blobs 写到 `accounts:start:end::asset` 这类键上，
  // 首页按真实币种读永远读不到。这里在组装前自行补齐；补到值且 scope 未变时回写 Redux。
  const backendURL = configuration.backendURL || credential.backendURL;
  const resolved = await resolveCurrencyCode(
    state.currencies?.currentCode ?? '',
    backendURL,
    scopeId,
    credential,
  );
  const { currencyCode } = resolved;

  if (!state.currencies?.currentCode) {
    // HomeScreen 的 getCurrencies 可能刚失败，Redux 仍是空串；把本轮探测或缓存兜底
    // 得到的币种写回，避免 blobs 已写好但首页仍按空币种键读。只在 scope 未变时写，
    // 防止切号窗口把新账号的币种写到别的分区显示上。
    try {
      const db = getDb();
      if (await getCurrentScope(db) === scopeId) {
        store.dispatch.currencies.setCurrentCode(currencyCode);
      }
    } catch {
      // 回写失败不影响本轮同步。
    }
  }
  // rangeDetails 来自 Redux（firefly 不在 persist 白名单，冷启动时是 INITIAL_STATE 的
  // 当前季度）；缺失时退回 pull 的增量窗口，避免拼出 `start=:end=` 这种空区间 URL。
  const fallback = computePullWindow(new Date(), false);
  const start = state.firefly.rangeDetails?.start || fallback.start;
  const end = state.firefly.rangeDetails?.end || fallback.end;

  const ctx: SyncContext = {
    // backendURL 以 Redux 为准（用户可在设置里切换），credential 里的只是兜底。
    backendURL,
    accessToken: resolved.accessToken,
    http,
    range: { start, end },
    currencyCode,
    displayAllAccounts: configuration.displayAllAccounts,
    apiVersion: configuration.apiVersion,
    // 图表品牌色只是展示细节，blob 层缺省时用默认橙色。
    selectedBrandStyle: configuration.selectedBrandStyle,
    refreshToken: () => refreshAccessToken(credential),
  };

  activeContext = ctx;
  return ctx;
}
