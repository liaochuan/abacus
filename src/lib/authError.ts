// 凭证登录失败的分类。只用结构判断，不 import axios：
// - `network`：请求没有到达服务端（离线/超时/DNS/fetch 失败），本地数据仍然有效；
// - `auth`：服务端明确拒绝 token（401/403），需要重新登录；
// - `other`：其余错误，提示后保留凭证。
export type AuthErrorKind = 'network' | 'auth' | 'other';

type AxiosLikeError = {
  isAxiosError?: boolean;
  code?: string;
  response?: { status?: number };
};

// expo-auth-session 的 refreshAsync 走 fetch 而不是 axios，断网时抛 TypeError
// （message 形如 "Network request failed"），没有 isAxiosError/code 标记，
// 所以还要按错误名与消息识别这一类网络失败。
const NETWORK_MESSAGE = /network|fetch|offline/i;

const isAxiosLike = (error: unknown): error is AxiosLikeError => (
  typeof error === 'object'
  && error !== null
  && (error as AxiosLikeError).isAxiosError === true
);

const isFetchNetworkError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; message?: unknown };
  if (candidate.name === 'TypeError') {
    return true;
  }
  return typeof candidate.message === 'string' && NETWORK_MESSAGE.test(candidate.message);
};

export function classifyAuthError(error: unknown): AuthErrorKind {
  if (isAxiosLike(error)) {
    if (error.code === 'ERR_NETWORK') {
      return 'network';
    }
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return 'auth';
    }
    return 'other';
  }
  if (isFetchNetworkError(error)) {
    return 'network';
  }
  return 'other';
}
