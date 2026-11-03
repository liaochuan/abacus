import React, { useEffect, useRef, useState } from 'react';
import {
  Animated, Easing, Modal, Platform, Pressable, StyleSheet, View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import moment from 'moment';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import translate from '../../i18n/locale';
import type { SyncSummary } from '../../db/useSyncSummary';
import { useSyncSummary } from '../../db/useSyncSummary';
import type { SyncErrorKind } from '../../db/syncErrors';
import { getSyncState, isSyncFailing, subscribeSyncChanged } from '../../db/syncState';
import { requestSync } from '../../lib/syncScheduler';
import { useThemeColors } from '../../lib/common';
import { AButton, AText } from './ALibrary';
import SyncIssueList from './SyncIssueList';

// 顶栏同步图标：同步状态的唯一常驻入口。
// 图标只有三种语义（同步中 / 已同步 / 同步失败），离线单独用灰色区分：
// 离线是用户已知的常态，不该被当成失败；但也不能显示成「已同步」。
// 点击弹出气泡展示计数、上次成功时间与失败原因，并保留手动同步入口。
// 气泡只读摘要与状态机里的固定枚举，不接触 payload / 账户名 / token。

export type SyncVisualKind = 'syncing' | 'offline' | 'failed' | 'synced';

export type SyncFlags = {
  syncing: boolean;
  failing: boolean;
  /** 上一轮因离线没跑成。网络恢复后要等一次成功同步才清掉。 */
  offline: boolean;
  reason?: SyncErrorKind;
};

// 判定顺序：同步中 > 离线 > 失败 > 已同步。
// 「失败」涵盖上一轮报错与仍有需处理项（problems）两种情况。
// 离线看两个来源：当前网络状态，以及状态机里上一次因离线失败的结论——
// 后者在网络刚恢复、补跑还没发生时仍成立，不能直接显示成「已同步」。
export function syncStatusKind(
  summary: SyncSummary,
  flags: { syncing: boolean; failing: boolean; offline?: boolean },
): SyncVisualKind {
  if (flags.syncing) {
    return 'syncing';
  }
  if (summary.online === false || flags.offline === true) {
    return 'offline';
  }
  if (flags.failing === true || summary.problems > 0) {
    return 'failed';
  }
  return 'synced';
}

// iOS 上第二个 Modal 要等第一个 dismiss 完才能 present；onDismiss 不回调时的兜底时长。
const TOOLTIP_DISMISS_TIMEOUT_MS = 400;

const ICONS: Record<SyncVisualKind, 'refresh-cw' | 'check-circle' | 'alert-circle' | 'wifi-off'> = {
  syncing: 'refresh-cw',
  synced: 'check-circle',
  failed: 'alert-circle',
  offline: 'wifi-off',
};

export function syncStatusLabel(kind: SyncVisualKind): string {
  switch (kind) {
    case 'syncing':
      return translate('sync_status_syncing');
    case 'offline':
      return translate('sync_status_offline');
    case 'failed':
      return translate('sync_status_error');
    default:
      return translate('sync_status_synced');
  }
}

// lastSyncedAt 是 UTC 的 ISO 串：moment 会转成本地时间，与设备时区一致。
// 按 ISO 严格解析：坏值（空串、脏数据）退回「尚未同步」，不让界面出现 Invalid date。
export function syncLastSyncedLabel(lastSyncedAt: string | null): string {
  if (lastSyncedAt === null) {
    return translate('sync_tooltip_never_synced');
  }
  const parsed = moment(lastSyncedAt, moment.ISO_8601, true);
  if (!parsed.isValid()) {
    return translate('sync_tooltip_never_synced');
  }
  return parsed.format('YYYY-MM-DD HH:mm');
}

// 显式穷尽 SyncErrorKind：新增分类时 tsc 会逼着补词条，避免界面露出 key。
const REASON_KEYS: Record<SyncErrorKind, string> = {
  network: 'sync_error_reason_network',
  auth: 'sync_error_reason_auth',
  gone: 'sync_error_reason_gone',
  invalid: 'sync_error_reason_invalid',
  server: 'sync_error_reason_server',
  other: 'sync_error_reason_other',
};

export function syncReasonLabel(reason?: SyncErrorKind): string | null {
  if (!reason) {
    return null;
  }
  return translate(REASON_KEYS[reason]);
}

// 同步中与「上一轮失败」都取自模块级状态机：摘要来自库里的计数，
// 同步阶段变化不会改计数，必须单独订阅状态事件才会及时更新。
function flagsOf(): SyncFlags {
  const state = getSyncState();
  return {
    syncing: state.kind === 'syncing',
    failing: isSyncFailing(state),
    offline: state.kind === 'offline',
    reason: state.kind === 'error' ? state.reason : undefined,
  };
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

function TooltipRow({ label, value }: { label: string; value: string }) {
  const { colors } = useThemeColors();

  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginTop: 6,
      }}
    >
      <AText fontSize={11} color={colors.tabInactiveDarkLight}>{label}</AText>
      <AText
        fontSize={12}
        numberOfLines={2}
        maxWidth="70%"
        textAlign="right"
        style={{ marginLeft: 8 }}
      >
        {value}
      </AText>
    </View>
  );
}

export default function SyncStatusIcon() {
  const { colors } = useThemeColors();
  const insets = useSafeAreaInsets();
  const summary = useSyncSummary();
  const navigation = useNavigation();
  const {
    syncing, failing, offline, reason,
  } = useSyncFlags();
  const [open, setOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  // iOS 不能在同一帧里先 dismiss 一个 Modal 再 present 另一个：
  // 点「查看需处理项」时先把意图记下来，等气泡的 dismiss 回调（或兜底定时器）再打开列表。
  const issuesAfterDismiss = useRef(false);
  const issuesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (issuesTimer.current !== null) {
      clearTimeout(issuesTimer.current);
    }
  }, []);

  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!syncing) {
      // 先 stopAnimation 再归零：直接 setValue 会和原生动画的收尾帧竞争，
      // 偶尔把图标停在半圈（看起来倒置）上。
      spin.stopAnimation(() => spin.setValue(0));
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
      spin.stopAnimation(() => spin.setValue(0));
    };
  }, [syncing, spin]);

  // 底部 tab 切换不会卸载页面，而 Modal 是独立原生窗口：失焦时主动收起，
  // 避免切到别的页面后还盖着一层遮罩。
  useEffect(() => navigation.addListener('blur', () => {
    setOpen(false);
    setIssuesOpen(false);
    issuesAfterDismiss.current = false;
  }), [navigation]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const kind = syncStatusKind(summary, { syncing, failing, offline });
  // 已同步但队列还有积压时，标题直接说「N 条待上传」：
  // 单说「已同步」会和同一气泡里的待上传计数自相矛盾。
  const title = (kind === 'synced' && summary.pending > 0)
    ? translate('sync_status_pending', { count: summary.pending })
    : syncStatusLabel(kind);
  const reasonLabel = kind === 'failed' ? syncReasonLabel(reason) : null;

  const color = kind === 'failed'
    ? colors.brandDanger
    : (kind === 'offline' ? colors.tabInactiveDarkLight : colors.text);
  // 全部正常时整体淡出：图标常驻但不抢注意力，异常时才恢复对比度。
  const opacity = kind === 'synced' ? 0.6 : 1;

  const closeTooltip = () => {
    setOpen(false);
    setIssuesOpen(false);
  };

  const handleSyncNow = () => {
    // fire-and-forget：同步失败只影响图标状态，不阻塞用户操作。
    requestSync('manual').catch(() => {});
    closeTooltip();
  };

  const openIssuesNow = () => {
    issuesAfterDismiss.current = false;
    setIssuesOpen(true);
  };

  const handleOpenIssues = () => {
    setOpen(false);
    if (Platform.OS !== 'ios') {
      openIssuesNow();
      return;
    }

    issuesAfterDismiss.current = true;
    // onDismiss 在部分 iOS 版本不会回调，用一次性定时器兜底，避免点了没反应。
    if (issuesTimer.current !== null) {
      clearTimeout(issuesTimer.current);
    }
    issuesTimer.current = setTimeout(() => {
      issuesTimer.current = null;
      if (issuesAfterDismiss.current) {
        openIssuesNow();
      }
    }, TOOLTIP_DISMISS_TIMEOUT_MS);
  };

  const handleTooltipDismissed = () => {
    if (issuesTimer.current !== null) {
      clearTimeout(issuesTimer.current);
      issuesTimer.current = null;
    }
    if (issuesAfterDismiss.current) {
      openIssuesNow();
    }
  };

  return (
    <>
      <Pressable
        testID="sync_status_icon"
        accessibilityRole="button"
        accessibilityLabel={`${title} · ${translate('sync_tooltip_open')}`}
        hitSlop={6}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          // 与筛选按钮 / 左右切换按钮的 40px 高度对齐：三个图标的中心都在 y=20。
          width: 32,
          height: 40,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 10,
          backgroundColor: pressed ? colors.listPressed : 'transparent',
        })}
      >
        <Animated.View
          testID="sync_status_icon_spin"
          // 只在同步中挂旋转：即使动画因原生层收尾残留了角度，静止时也一定回正。
          style={syncing ? { transform: [{ rotate }], opacity } : { opacity }}
        >
          <Feather name={ICONS[kind]} size={18} color={color} />
        </Animated.View>
      </Pressable>

      <Modal
        transparent
        visible={open}
        animationType="fade"
        onRequestClose={closeTooltip}
        onDismiss={handleTooltipDismissed}
      >
        <View style={{ flex: 1 }}>
          <Pressable
            testID="sync_tooltip_backdrop"
            accessibilityRole="button"
            accessibilityLabel={translate('sync_notice_close')}
            style={StyleSheet.absoluteFill}
            onPress={closeTooltip}
          />
          <View pointerEvents="box-none" style={{ flex: 1, alignItems: 'flex-end' }}>
            <View
              testID="sync_tooltip"
              accessibilityViewIsModal
              // 遮罩是这张卡片的兄弟节点，点卡片本体并不会落到遮罩上；
              // 这里显式声明为响应者作为兜底，万一以后卡片被挪进遮罩里也不会误关。
              onStartShouldSetResponder={() => true}
              style={{
                width: 260,
                marginTop: insets.top + 48,
                marginRight: 12,
                padding: 12,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.listBorderColor,
                backgroundColor: colors.tileBackgroundColor,
              }}
            >
              <AText fontSize={14} bold color={color}>{title}</AText>

              <TooltipRow
                label={translate('sync_tooltip_last_synced')}
                value={syncLastSyncedLabel(summary.lastSyncedAt)}
              />
              {summary.pending > 0 ? (
                <AText fontSize={12} style={{ marginTop: 6 }}>
                  {translate('sync_status_pending', { count: summary.pending })}
                </AText>
              ) : null}
              {summary.problems > 0 ? (
                <AText fontSize={12} color={colors.brandDanger} style={{ marginTop: 6 }}>
                  {translate('sync_status_problems', { count: summary.problems })}
                </AText>
              ) : null}
              {reasonLabel !== null ? (
                <TooltipRow label={translate('sync_tooltip_reason')} value={reasonLabel} />
              ) : null}

              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                {summary.problems > 0 ? (
                  <AButton
                    testID="sync_tooltip_issues"
                    type="info"
                    onPress={handleOpenIssues}
                    accessibilityRole="button"
                    accessibilityLabel={translate('sync_tooltip_issues')}
                    style={{ flex: 1, height: 36, marginBottom: 0 }}
                  >
                    <AText
                      fontSize={12}
                      bold
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.7}
                    >
                      {translate('sync_tooltip_issues')}
                    </AText>
                  </AButton>
                ) : null}
                <AButton
                  testID="sync_tooltip_sync_now"
                  type="primary"
                  disabled={syncing}
                  disabledTint
                  onPress={handleSyncNow}
                  accessibilityRole="button"
                  accessibilityLabel={translate('sync_tooltip_sync_now')}
                  style={{ flex: 1, height: 36, marginBottom: 0 }}
                >
                  <AText
                    fontSize={12}
                    bold
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.7}
                  >
                    {translate('sync_tooltip_sync_now')}
                  </AText>
                </AButton>
              </View>
            </View>
          </View>
        </View>
      </Modal>

      {/* 失败项列表单独成层：气泡关闭后仍由它自己管理可见性。 */}
      <SyncIssueList visible={issuesOpen} onClose={() => setIssuesOpen(false)} />
    </>
  );
}
