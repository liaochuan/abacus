import NetInfo from '@react-native-community/netinfo';

// 最后一次已知的连接状态；默认在线，避免首帧误判为离线。
let lastOnline = true;

NetInfo.addEventListener((state) => {
  lastOnline = state.isConnected !== false;
});

export function isOnline(): boolean {
  return lastOnline;
}

// 包装 NetInfo.addEventListener：只在布尔值变化时回调（订阅时的首个事件建立基线）。
export function subscribeNetwork(cb: (online: boolean) => void): () => void {
  let reported: boolean | null = null;
  return NetInfo.addEventListener((state) => {
    const online = state.isConnected !== false;
    if (online === reported) {
      return;
    }
    reported = online;
    cb(online);
  });
}
