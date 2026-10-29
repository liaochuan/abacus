import { guardOfflineWrite } from '../useOnlineGuard';

// jest 环境没有 NetInfo 原生模块：桩掉订阅接口，避免 import network.ts 时崩溃。
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

test('离线时阻止写入并提示', () => {
  const action = jest.fn();
  const notify = jest.fn();
  expect(guardOfflineWrite(false, action, notify)).toBe(false);
  expect(action).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith('offline_write_blocked');
  const action2 = jest.fn();
  expect(guardOfflineWrite(true, action2, notify)).toBe(true);
  expect(action2).toHaveBeenCalled();
  // 在线分支不追加提示：notify 仍只有离线时的那一次调用。
  expect(notify).toHaveBeenCalledTimes(1);
});
