import { classifySyncError, backoffDelay } from '../syncErrors';

test('错误分类', () => {
  expect(classifySyncError({ isAxiosError: true, code: 'ERR_NETWORK' })).toBe('network');
  expect(classifySyncError({ isAxiosError: true, response: { status: 401 } })).toBe('auth');
  expect(classifySyncError({ isAxiosError: true, response: { status: 404 } })).toBe('gone');
  expect(classifySyncError({ isAxiosError: true, response: { status: 422 } })).toBe('invalid');
  expect(classifySyncError({ isAxiosError: true, response: { status: 500 } })).toBe('server');
  expect(classifySyncError(new Error('x'))).toBe('other');
});

test('网络类错误：TypeError 与 message 关键字', () => {
  expect(classifySyncError(new TypeError('Failed to fetch'))).toBe('network');
  expect(classifySyncError(new Error('Network request failed'))).toBe('network');
  expect(classifySyncError(new Error('request timeout'))).toBe('network');
  expect(classifySyncError(new Error('device is offline'))).toBe('network');
  // 大小写不敏感
  expect(classifySyncError(new Error('FETCH ERROR'))).toBe('network');
});

test('HTTP 状态映射的边界', () => {
  expect(classifySyncError({ response: { status: 403 } })).toBe('auth');
  expect(classifySyncError({ response: { status: 409 } })).toBe('invalid');
  expect(classifySyncError({ response: { status: 418 } })).toBe('other');
  expect(classifySyncError({ response: { status: 599 } })).toBe('server');
  // 状态码缺失或非法时退化为 other
  expect(classifySyncError({ response: {} })).toBe('other');
  expect(classifySyncError({ response: { status: '500' } })).toBe('other');
});

test('非对象与空值兜底为 other', () => {
  expect(classifySyncError(undefined)).toBe('other');
  expect(classifySyncError(null)).toBe('other');
  expect(classifySyncError('network down')).toBe('other');
  expect(classifySyncError(42)).toBe('other');
});

test('HTTP 状态优先于网络类启发式', () => {
  // axios 超时错误自带 timeout 文案，但已拿到状态码时应按状态码分类
  expect(
    classifySyncError({
      isAxiosError: true,
      response: { status: 401 },
      message: 'timeout of 10000ms exceeded',
    }),
  ).toBe('auth');
  // 404 不应因为 message 含 network 而被当作可重试的网络错误
  expect(
    classifySyncError({
      isAxiosError: true,
      response: { status: 404 },
      message: 'network failure',
    }),
  ).toBe('gone');
});

test('退避递增且封顶 10 分钟', () => {
  expect(backoffDelay(1)).toBe(30_000);
  expect(backoffDelay(2)).toBe(120_000);
  expect(backoffDelay(3)).toBe(600_000);
  expect(backoffDelay(9)).toBe(600_000);
});

test('退避对非法 attempts 钳制到首次间隔', () => {
  expect(backoffDelay(0)).toBe(30_000);
  expect(backoffDelay(-1)).toBe(30_000);
  expect(backoffDelay(Number.NaN)).toBe(30_000);
  expect(backoffDelay(Number.POSITIVE_INFINITY)).toBe(30_000);
});
