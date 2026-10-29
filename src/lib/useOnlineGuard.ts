import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';

import translate from '../i18n/locale';
import { isOnline, subscribeNetwork } from './network';

// 离线只读守卫：与服务端写入相关的入口（新增/编辑/删除）在离线时必须提前拦截，
// 避免用户操作后只看到失败提示。纯本地的 UI 状态（筛选、开关、主题）不要走这里。
export function guardOfflineWrite(
  online: boolean,
  action: () => void,
  notify: (msg: string) => void,
): boolean {
  if (!online) {
    notify('offline_write_blocked');
    return false;
  }
  action();
  return true;
}

// 订阅连接状态：`online` 供 UI 置灰，`guard` 用于包住真正写服务端的动作。
export function useOnlineGuard(): { online: boolean; guard: (action: () => void) => boolean } {
  const [online, setOnline] = useState<boolean>(() => isOnline());

  useEffect(() => subscribeNetwork(setOnline), []);

  const guard = useCallback((action: () => void) => guardOfflineWrite(
    online,
    action,
    (key) => Alert.alert(translate(key)),
  ), [online]);

  return { online, guard };
}
