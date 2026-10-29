import { bootPhase } from '../bootState';

test('启动阶段只取决于数据库与凭证，不等待大快照', () => {
  expect(bootPhase({ dbReady: false, credentialReady: false })).toBe('loading');
  expect(bootPhase({ dbReady: false, credentialReady: true })).toBe('loading');
  expect(bootPhase({ dbReady: true, credentialReady: false })).toBe('loading');
  expect(bootPhase({ dbReady: true, credentialReady: true })).toBe('ready');
});

test('failed 为 true 时返回 degraded，不报告 ready', () => {
  expect(bootPhase({ dbReady: true, credentialReady: true, failed: true })).toBe('degraded');
  expect(bootPhase({ dbReady: false, credentialReady: false, failed: true })).toBe('degraded');
});

test('凭据读取失败（credentialReady=false + failed=true）不误报 ready', () => {
  expect(bootPhase({ dbReady: true, credentialReady: false, failed: true })).toBe('degraded');
  // 对照：无凭据但成功解析（credentialReady=true）仍为 ready。
  expect(bootPhase({ dbReady: true, credentialReady: true })).toBe('ready');
});
