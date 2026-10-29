import { useEffect } from 'react';
import { AppState } from 'react-native';

import { subscribeNetwork } from './network';
import { requestSync, startSyncTimer, stopSyncTimer } from './syncScheduler';

// 全局触发接线：组件本身不渲染任何东西，只在挂载时注册触发点。
// 由 AppBootstrap 只在 bootstrap phase === 'ready' 时挂载（degraded 不挂），
// 因此「启动同步」天然发生在数据库与凭据就绪之后，不会在 loading/degraded 阶段先跑一轮空同步。
//
// 所有触发都是 fire-and-forget：同步失败只改状态条，不打断 UI、不弹窗。
export default function SyncTriggers() {
  useEffect(() => {
    // 1. 启动：bootstrap 完成即同步一次（首次会拉 365 天全量窗口）。
    requestSync('startup').catch(() => {});

    // 2. 回到前台：锁屏/切后台回来时补一轮，覆盖「后台期间服务端有变动」。
    const appStateSubscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        requestSync('foreground').catch(() => {});
      }
    });

    // 3. 网络恢复：订阅时的首个事件只是基线（不是「恢复」），忽略它；
    //    之后 false → true 才算恢复，立刻补一轮。
    let sawNetworkBaseline = false;
    const unsubscribeNetwork = subscribeNetwork((online) => {
      if (!sawNetworkBaseline) {
        sawNetworkBaseline = true;
        return;
      }
      if (online) {
        requestSync('online').catch(() => {});
      }
    });

    // 4. 定时：自续期，间隔由 pending 数决定（见 nextSyncDelay）。
    startSyncTimer();

    return () => {
      appStateSubscription.remove();
      unsubscribeNetwork();
      stopSyncTimer();
    };
  }, []);

  return null;
}
