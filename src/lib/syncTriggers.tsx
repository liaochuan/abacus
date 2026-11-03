import { useEffect } from 'react';
import { AppState } from 'react-native';

import { subscribeNetwork } from './network';
import {
  requestSync,
  requestSyncIfDue,
  startSyncTimer,
  stopSyncTimer,
} from './syncScheduler';

// 全局触发接线：组件本身不渲染任何东西，只在挂载时注册触发点。
// 由 AppBootstrap 只在 bootstrap phase === 'ready' 时挂载（degraded 不挂），
// 因此「启动同步」天然发生在数据库与凭据就绪之后，不会在 loading/degraded 阶段先跑一轮空同步。
//
// 自动触发点：冷启动、后台转前台（5 分钟间隔）、首页/图表数据维度变化、下拉刷新；
// 其余为可靠性兜底（网络恢复、outbox 积压重试）。
// 1. 冷启动：无条件同步一次；
// 2. 后台转回前台：与上次成功同步比较，不足 5 分钟不发请求；
// 3. 首页下拉刷新：由 HomeScreen 的 refreshWithSync 触发 manual。
// 另外保留网络恢复立即同步，以及 outbox 有积压时的 60 秒重试。
//
// 所有触发都是 fire-and-forget：同步失败只改状态条，不打断 UI、不弹窗。
export default function SyncTriggers() {
  useEffect(() => {
    // 1. 启动：bootstrap 完成即同步一次（首次会拉 365 天全量窗口）。
    requestSync('startup').catch(() => {});

    // 2. 回到前台：只有真正的「后台/非活跃 → active」才算恢复；
    //    冷启动的 active 由上面的 startup 负责，避免重复请求。
    //    恢复时先比较 last_synced_at，距上次成功不足 5 分钟直接跳过。
    let appState = AppState.currentState;
    const appStateSubscription = AppState.addEventListener('change', (status) => {
      const wasActive = appState === 'active';
      appState = status;
      if (status === 'active' && !wasActive) {
        requestSyncIfDue('foreground').catch(() => {});
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

    // 4. 定时：只在 outbox 有积压时按 60 秒重试，空闲时自动停表。
    startSyncTimer();

    return () => {
      appStateSubscription.remove();
      unsubscribeNetwork();
      stopSyncTimer();
    };
  }, []);

  return null;
}
