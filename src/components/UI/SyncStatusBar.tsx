import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { AntDesign } from '@expo/vector-icons';
import moment from 'moment';

import translate from '../../i18n/locale';
import type { SyncSummary } from '../../db/useSyncSummary';
import { useSyncSummary } from '../../db/useSyncSummary';
import { getSyncState, isSyncFailing, subscribeSyncChanged } from '../../db/syncState';
import { requestSync } from '../../lib/syncScheduler';
import { useThemeColors } from '../../lib/common';
import { APressable, AStackFlex, AText } from './ALibrary';
import SyncIssueList from './SyncIssueList';

// 状态条文案的唯一来源（导出以便单测按优先级断言）。
// 优先级：同步中 > 离线 > 同步出错 > 需处理 > 待上传 > 已同步。
// 「同步出错」必须排在「已同步」之前：上一轮确实失败了，
// 显示「已同步 · 12:30」会让用户以为数据已经上去了。
// 只用摘要里的四个数字、一次本地时间格式化与状态机里的一个布尔，不接触 payload / 账户名 / token。
export function statusBarText(
  summary: SyncSummary,
  state: { syncing: boolean; failing?: boolean },
): string {
  if (state.syncing) {
    return translate('sync_status_syncing');
  }
  if (summary.online === false) {
    return translate('sync_status_offline');
  }
  if (state.failing === true) {
    return translate('sync_status_error');
  }
  if (summary.problems > 0) {
    return translate('sync_status_problems', { count: summary.problems });
  }
  if (summary.pending > 0) {
    return translate('sync_status_pending', { count: summary.pending });
  }

  const synced = translate('sync_status_synced');
  if (summary.lastSyncedAt === null) {
    return synced;
  }
  // lastSyncedAt 是 UTC 的 ISO 串：moment 会转成本地时间，HH:mm 与设备时区一致。
  return `${synced} · ${moment(summary.lastSyncedAt).format('HH:mm')}`;
}

// 同步中与「上一轮失败」都取自模块级状态机，而不是 useSyncSummary：
// 摘要来自库里的计数，同步阶段变化不会改计数，必须单独订阅状态事件才会及时更新。
type SyncFlags = { syncing: boolean; failing: boolean };

function flagsOf(): SyncFlags {
  const state = getSyncState();
  return { syncing: state.kind === 'syncing', failing: isSyncFailing(state) };
}

function useSyncFlags(): SyncFlags {
  const [flags, setFlags] = useState<SyncFlags>(flagsOf);

  useEffect(() => {
    // 订阅前后状态可能已经变过：先读一次，再靠事件保持同步。
    const update = () => setFlags(flagsOf());
    update();
    return subscribeSyncChanged(update);
  }, []);

  return flags;
}

export default function SyncStatusBar() {
  const { colors } = useThemeColors();
  const summary = useSyncSummary();
  const { syncing, failing } = useSyncFlags();
  const [issuesOpen, setIssuesOpen] = useState(false);

  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!syncing) {
      // 停下时归零，避免下一次同步从半圈开始。
      spin.setValue(0);
      return undefined;
    }

    const animation = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    animation.start();

    return () => {
      animation.stop();
    };
  }, [syncing, spin]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const text = statusBarText(summary, { syncing, failing });
  // 全部正常时整体淡出：状态条常驻但不抢注意力，异常时才恢复对比度。
  const calm = !syncing && !failing && summary.online
    && summary.problems === 0 && summary.pending === 0;
  const color = summary.problems > 0 || failing ? colors.brandDanger : colors.text;

  // 只有「需处理」才有可点的列表：其余状态下点击文案不做事，
  // 避免用户以为「已同步」也能点开什么东西。
  const handlePressText = () => {
    if (summary.problems > 0) {
      setIssuesOpen(true);
    }
  };

  const handlePressSync = () => {
    // fire-and-forget：同步失败只影响状态条，不阻塞用户操作。
    requestSync('manual').catch(() => {});
  };

  return (
    <AStackFlex
      row
      flex={0}
      justifyContent="space-between"
      px={10}
      style={{
        height: 24,
        opacity: calm ? 0.6 : 1,
      }}
    >
      <AText
        fontSize={11}
        numberOfLines={1}
        color={color}
        onPress={handlePressText}
        style={{ flex: 1 }}
      >
        {text}
      </AText>

      <APressable
        testID="sync_status_bar_button"
        disabled={syncing}
        onPress={handlePressSync}
        style={{
          width: 28,
          height: 24,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Animated.View style={{ transform: [{ rotate }] }}>
          <AntDesign name="sync" size={14} color={color} />
        </Animated.View>
      </APressable>

      {/* Modal 单独成层，不参与这一行的布局；放在这里是为了给状态条一个稳定的根节点。 */}
      <SyncIssueList visible={issuesOpen} onClose={() => setIssuesOpen(false)} />
    </AStackFlex>
  );
}
