// 同步错误分类与退避：纯函数，无依赖，便于在 outbox 调度与测试中直接复用。
// 通过结构化字段识别 axios 错误，避免为此引入 axios 运行时依赖。

export type SyncErrorKind = 'network' | 'auth' | 'gone' | 'invalid' | 'server' | 'other';

const NETWORK_MESSAGE = /network|fetch|offline|timeout/i;

function readStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const response = (error as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null) {
    return null;
  }
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

// 注意：编程错误（如 TypeError: cannot read property of undefined）同样命中此分支，
// 会被当作可重试的网络错误。由 03-T7 在连续网络类失败后停止重试来兜底。
function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === 'ERR_NETWORK') {
    return true;
  }
  return typeof message === 'string' && NETWORK_MESSAGE.test(message);
}

// 判定顺序：先看服务端状态码（服务端已应答，结论最可靠），
// 仅在无状态码时才使用网络类启发式；未知状态码与非 HTTP 错误归入 other。
export function classifySyncError(error: unknown): SyncErrorKind {
  const status = readStatus(error);
  if (status !== null) {
    if (status === 401 || status === 403) {
      return 'auth';
    }
    if (status === 404) {
      return 'gone';
    }
    if (status === 409 || status === 422) {
      return 'invalid';
    }
    if (status >= 500 && status < 600) {
      return 'server';
    }
    return 'other';
  }
  if (isNetworkError(error)) {
    return 'network';
  }
  return 'other';
}

// 退避：前两次重试 30s、120s，之后固定 10 分钟，避免长时间离线时无限增长。
// 非法 attempts（非有限值或 < 1）按首次间隔处理，避免 4 ** (attempts - 1) 产生无意义值。
export function backoffDelay(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 1) {
    return 30_000;
  }
  if (attempts >= 3) {
    return 600_000;
  }
  return 30_000 * 4 ** (attempts - 1);
}
