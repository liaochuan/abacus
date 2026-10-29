import { classifyAuthError } from '../authError';

// 凭证登录失败的分类：只有网络错误可以在有本地数据时继续进 dashboard，
// 认证失败提示重新登录，其余错误仅供参考。任何分支都不得删除凭证。
test('网络错误不删除凭证', () => {
  expect(classifyAuthError({ isAxiosError: true, code: 'ERR_NETWORK' })).toBe('network');
  expect(classifyAuthError({ isAxiosError: true, response: { status: 401 } })).toBe('auth');
  expect(classifyAuthError({ isAxiosError: true, response: { status: 500 } })).toBe('other');
  expect(classifyAuthError(new Error('boom'))).toBe('other');
});

test('401 与 403 都视为认证失败', () => {
  expect(classifyAuthError({ isAxiosError: true, response: { status: 403 } })).toBe('auth');
});

test('非 axios 错误、空值与字符串一律归为 other', () => {
  expect(classifyAuthError(null)).toBe('other');
  expect(classifyAuthError(undefined)).toBe('other');
  expect(classifyAuthError('network down')).toBe('other');
  expect(classifyAuthError({ code: 'ERR_NETWORK' })).toBe('other');
});

test('axios 错误缺少 response 时不是认证失败', () => {
  expect(classifyAuthError({ isAxiosError: true })).toBe('other');
  expect(classifyAuthError({ isAxiosError: true, response: {} })).toBe('other');
});

// expo-auth-session 的 refreshAsync 走 fetch，断网时抛的是 TypeError（message 形如
// "Network request failed"），没有 axios 的 isAxiosError/code 标记。这两类必须算网络错误，
// 否则离线冷启动进不了 dashboard。
test('fetch 的 TypeError 视为网络错误', () => {
  expect(classifyAuthError(new TypeError('Network request failed'))).toBe('network');
  expect(classifyAuthError(new TypeError('Failed to fetch'))).toBe('network');
  expect(classifyAuthError(Object.assign(new Error('boom'), { name: 'TypeError' }))).toBe('network');
});

test('消息含 network/fetch/offline 的错误视为网络错误', () => {
  expect(classifyAuthError(new Error('Network request failed'))).toBe('network');
  expect(classifyAuthError(new Error('fetch failed'))).toBe('network');
  expect(classifyAuthError(new Error('Device is offline'))).toBe('network');
  expect(classifyAuthError({ message: 'Network request failed' })).toBe('network');
});

test('消息不匹配的普通 Error 仍是 other', () => {
  expect(classifyAuthError(new Error('invalid_grant'))).toBe('other');
  expect(classifyAuthError(new Error('boom'))).toBe('other');
});
