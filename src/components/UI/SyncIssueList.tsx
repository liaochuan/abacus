import React, { useEffect, useRef, useState } from 'react';
import {
  Alert, Modal, ScrollView, View,
} from 'react-native';

import translate from '../../i18n/locale';
import { getDb } from '../../db/instance';
import { getCurrentScope } from '../../db/scope';
import {
  dropOutboxItem,
  issueLabel,
  listIssues,
  retryOutboxItem,
} from '../../db/outbox';
import type { OutboxItem } from '../../db/outbox';
import { emitSyncChanged, subscribeSyncChanged } from '../../db/syncState';
import type { Db } from '../../db/types';
import { requestSync } from '../../lib/syncScheduler';
import { D_HEIGHT, useThemeColors } from '../../lib/common';
import type { TransactionType } from '../../models/transactions';
import {
  AButton, AText,
} from './ALibrary';

// 失败项处理列表（04-T5）：「需处理」的唯一出口。
// - 只读 outbox 的 failed 行（listIssues），不读 payload 之外的任何数据；
// - 每条只展示描述、日期、原因与两个动作，避免把内部错误串或 id 暴露给用户；
// - 重试 = 回到 pending 并唤醒一轮同步；放弃 = 删除意图（本地新建连交易一起删），
//   两种操作都需要用户显式点击，不做自动清理。

const pad2 = (value: number): string => `${value}`.padStart(2, '0');

// 与 SyncNoticeModal 一致：payload 里的日期可能是 'YYYY-MM-DD'、ISO 串或 Date，
// 统一按本地日历日展示，避免 UTC 转换把日期挪一天。
const dayLabel = (value: unknown): string => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return '';
    }
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }
  if (typeof value === 'string') {
    const day = value.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return day;
    }
  }
  return '';
};

const firstSplit = (payload: TransactionType) => payload?.attributes?.transactions?.[0];

// 描述与交易列表同源：组标题 + 首条明细描述；都为空时退回占位符。
const descriptionOf = (payload: TransactionType): string => {
  const groupTitle = payload?.attributes?.groupTitle;
  const description = firstSplit(payload)?.description;
  const parts = [groupTitle, description]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return parts.length > 0 ? parts.join(': ') : '—';
};

// 交易日期优先；payload 里没有日期时退回入队时间（本地新建的 payload 可能缺字段）。
const dateOf = (item: OutboxItem): string => dayLabel(firstSplit(item.payload)?.date)
  || dayLabel(item.createdAt);

function IssueRow({
  item,
  busy,
  onRetry,
  onDrop,
}: {
  item: OutboxItem;
  busy: boolean;
  onRetry: () => void;
  onDrop: () => void;
}) {
  const { colors } = useThemeColors();
  // 404 表示服务端已删除该交易：重试永远不会成功，只保留「放弃本地改动」。
  const retryable = item.lastError !== '404';

  return (
    <View
      testID={`sync_issue_row_${item.id}`}
      style={{
        paddingVertical: 10,
        borderTopWidth: 1,
        borderColor: colors.listBorderColor,
      }}
    >
      <AText fontSize={13} bold numberOfLines={2}>{descriptionOf(item.payload)}</AText>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 2,
        }}
      >
        <AText fontSize={11} style={{ opacity: 0.6 }}>{dateOf(item)}</AText>
        <AText fontSize={11} color={colors.brandDanger}>
          {translate(issueLabel(item))}
        </AText>
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        {retryable ? (
          <AButton
            testID={`sync_issue_retry_${item.id}`}
            type="primary"
            disabled={busy}
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel={translate('sync_issue_retry')}
            style={{ height: 38, flex: 1, marginBottom: 0 }}
          >
            <AText fontSize={12} bold>{translate('sync_issue_retry')}</AText>
          </AButton>
        ) : null}
        <AButton
          testID={`sync_issue_drop_${item.id}`}
          type="info"
          disabled={busy}
          onPress={onDrop}
          accessibilityRole="button"
          accessibilityLabel={translate('sync_issue_drop')}
          style={{ height: 38, flex: 1, marginBottom: 0 }}
        >
          <AText fontSize={12} bold color={colors.brandDanger}>
            {translate('sync_issue_drop')}
          </AText>
        </AButton>
      </View>
    </View>
  );
}

type SyncIssueListProps = {
  visible: boolean;
  onClose: () => void;
};

export default function SyncIssueList({ visible, onClose }: SyncIssueListProps) {
  const { colors } = useThemeColors();
  const [issues, setIssues] = useState<OutboxItem[]>([]);
  // 首次读取完成前不显示「暂无待处理」：否则每次打开都会闪一下空态。
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 读库失败与操作失败要区别对待：前者必须显示错误 + 重试入口，且不能落到空态。
  const [loadFailed, setLoadFailed] = useState(false);
  // 自增后重跑 load effect（错误面板上的「重试」）。
  const [reloadKey, setReloadKey] = useState(0);
  // 同一帧内的第二次点击不会立刻反映到 busyId（state 更新是异步的），用 ref 兜底。
  const busyRef = useRef(false);

  useEffect(() => {
    if (!visible) {
      return undefined;
    }

    let cancelled = false;
    let generation = 0;

    // 重试/放弃后 emitSyncChanged 会回来触发重读；generation 防止旧结果覆盖新列表。
    const load = async () => {
      generation += 1;
      const current = generation;
      try {
        const db = getDb();
        const scopeId = await getCurrentScope(db);
        const next = await listIssues(db, scopeId);
        if (!cancelled && current === generation) {
          setIssues(next);
          setError(null);
          setLoadFailed(false);
          setLoaded(true);
        }
      } catch {
        // 库未就绪或账号已删除：保留当前列表，但必须把读取失败告诉用户，
        // 否则空列表会被误读成「没有需要处理的项」。弹窗保持打开，等用户重试。
        if (!cancelled && current === generation) {
          setError(translate('transaction_load_failed'));
          setLoadFailed(true);
          setLoaded(true);
        }
      }
    };

    setError(null);
    setLoadFailed(false);
    setLoaded(false);
    load();
    const unsubscribe = subscribeSyncChanged(load);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [visible, reloadKey]);

  // 两个动作共用同一套串行守卫：请求期间另一条按钮不可点，避免重复删除或重复入队。
  // 返回是否成功，调用方据此决定要不要唤醒同步（失败时队列没变，多余触发没有意义）。
  const runAction = async (
    item: OutboxItem,
    action: (db: Db) => Promise<void>,
  ): Promise<boolean> => {
    if (busyRef.current) {
      return false;
    }
    busyRef.current = true;
    setBusyId(item.id);
    setError(null);
    try {
      await action(getDb());
      // 列表与状态条都靠这条广播刷新：失败项减少后「需处理」计数随之更新。
      emitSyncChanged();
      return true;
    } catch {
      // 写失败时保留当前列表并提示，按钮在 finally 里恢复可用，可直接重试。
      setError(translate('error_widget_title'));
      return false;
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  };

  const handleRetry = async (item: OutboxItem) => {
    const ok = await runAction(item, async (db) => {
      await retryOutboxItem(db, item.id);
    });
    if (ok) {
      // fire-and-forget：同步失败只影响状态条，不阻塞用户关闭弹窗。
      requestSync('manual').catch(() => {});
    }
  };

  const handleDrop = (item: OutboxItem) => {
    if (busyRef.current) {
      return;
    }
    Alert.alert(
      translate('sync_issue_drop_confirm'),
      descriptionOf(item.payload),
      [
        { text: translate('cancel'), style: 'cancel' },
        {
          text: translate('sync_issue_drop'),
          style: 'destructive',
          onPress: () => {
            runAction(item, async (db) => {
              const scopeId = await getCurrentScope(db);
              await dropOutboxItem(db, scopeId, item);
            });
          },
        },
      ],
    );
  };

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      // Android 返回键等价于关闭：这里没有必须逐条确认的提示，可以直接退出。
      onRequestClose={onClose}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.45)',
          justifyContent: 'center',
          paddingHorizontal: 20,
        }}
      >
        <View
          testID="sync_issue_list"
          accessibilityViewIsModal
          style={{
            backgroundColor: colors.tileBackgroundColor,
            borderRadius: 16,
            padding: 16,
            maxHeight: D_HEIGHT * 0.75,
          }}
        >
          <AText fontSize={15} bold>
            {translate('sync_status_problems', { count: issues.length })}
          </AText>

          {error ? (
            <View testID="sync_issue_error" style={{ marginTop: 8 }}>
              <AText color={colors.brandDanger} fontSize={12}>
                {error}
              </AText>
              {loadFailed ? (
                <AButton
                  testID="sync_issue_reload"
                  type="primary"
                  onPress={() => setReloadKey((key) => key + 1)}
                  accessibilityRole="button"
                  accessibilityLabel={translate('sync_issue_reload')}
                  style={{ height: 36, marginTop: 8, marginBottom: 0 }}
                >
                  <AText fontSize={12} bold>{translate('sync_issue_reload')}</AText>
                </AButton>
              ) : null}
            </View>
          ) : null}

          <ScrollView
            style={{ flexGrow: 0, flexShrink: 1 }}
            contentContainerStyle={{ paddingBottom: 2 }}
            showsVerticalScrollIndicator={false}
          >
            {loaded && !loadFailed && issues.length === 0 ? (
              <View testID="sync_issue_empty">
                <AText fontSize={12} style={{ marginTop: 12, opacity: 0.7 }}>
                  {translate('sync_issue_empty')}
                </AText>
              </View>
            ) : null}

            {issues.map((item) => (
              <IssueRow
                key={item.id}
                item={item}
                busy={busyId === item.id}
                onRetry={() => handleRetry(item)}
                onDrop={() => handleDrop(item)}
              />
            ))}
          </ScrollView>

          <AButton
            testID="sync_issue_close"
            type="info"
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={translate('sync_notice_close')}
            style={{ height: 40, marginTop: 12, marginBottom: 0 }}
          >
            <AText fontSize={12} bold>{translate('sync_notice_close')}</AText>
          </AButton>
        </View>
      </View>
    </Modal>
  );
}
