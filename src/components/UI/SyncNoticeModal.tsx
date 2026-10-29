import React, { useEffect, useRef, useState } from 'react';
import {
  AppState, Modal, ScrollView, View,
} from 'react-native';
import moment from 'moment';

import translate from '../../i18n/locale';
import { getDb } from '../../db/instance';
import { getCurrentScope } from '../../db/scope';
import {
  acknowledgeNotice,
  diffTransaction,
  listOpenNotices,
} from '../../db/notices';
import type { NoticeRow, TransactionDiff } from '../../db/notices';
import {
  CONNECTION_ALERT_ACKNOWLEDGED_AT_META_KEY,
  CONNECTION_ALERT_LEVEL_META_KEY,
  LAST_SYNC_ERROR_META_KEY,
  connectionAlertLevel,
  daysSinceLastSync,
  shouldShowConnectionAlert,
} from '../../db/connectionAlert';
import type { ConnectionAlertLevel } from '../../db/connectionAlert';
import { getMeta, setMeta } from '../../db/repository';
import {
  emitSyncChanged,
  getSyncState,
  isSyncFailing,
  subscribeSyncChanged,
} from '../../db/syncState';
import { readSyncSummary } from '../../db/useSyncSummary';
import { isOnline, subscribeNetwork } from '../../lib/network';
import type { TransactionSplitType, TransactionType } from '../../models/transactions';
import { D_HEIGHT, useThemeColors } from '../../lib/common';
import {
  AButton, AStackFlex, AText, AView,
} from './ALibrary';

// 统一提示弹窗（spec §7.8）：冲突、服务端删除与连接异常共用一个 Modal。
// - 冲突/删除：只有库里有未确认的 notices 才显示；点「关闭」逐条回填 acknowledged_at，
//   因此不会自动消失，也不会被背景点击误关。
// - 连接异常：库里没有 notice，只是一条「多久没成功同步」的虚拟条目，
//   排在最前；离线或上一轮同步失败时才出现，关闭时把档位与确认时间写进 meta。
// - conflict：逐 split 展开差异表（本地 / 服务端两列）。
// - server_deletion：展示删除前最后一份快照的日期、描述、金额、账户、分类、标签。
// - 不提供「撤销本地修改」「恢复被删交易」，只做告知（控制器裁定）。

// diff 的字段 key → 既有词条。组标题与类型在表单里已有对应文案，直接复用，
// 不为此新增一次性 key；缺词条的语言由 i18n-js 的 en-US fallback 兜底。
const FIELD_LABELS: Record<string, string> = {
  group_title: 'transaction_form_group_title_label',
  description: 'transaction_form_description_label',
  amount: 'transaction_form_amount_label',
  date: 'transaction_form_date_label',
  type: 'transaction_type_label',
  categoryName: 'transaction_form_category_label',
  budgetName: 'transaction_form_budget_label',
  tags: 'transaction_form_tags_label',
  notes: 'transaction_form_notes_label',
  sourceName: 'transaction_form_sourceAccount_label',
  destinationName: 'transaction_form_destinationAccount_label',
  split_missing_on_server: 'sync_notice_split_only_local',
  split_missing_locally: 'sync_notice_split_only_server',
};

const KNOWN_TYPES = ['withdrawal', 'deposit', 'transfer'];

const pad2 = (value: number): string => `${value}`.padStart(2, '0');

// 只到天：payload 里可能是 'YYYY-MM-DD'、ISO 串或 Date（本地新建时是 Date），
// 统一按本地日历日展示，避免 UTC 转换把日期挪一天。
const dateLabel = (value: string | Date | undefined): string => {
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

const fieldLabel = (field: string): string => translate(FIELD_LABELS[field] ?? field);

// 值本身不翻译，只有 type 这类枚举用表单已有的词条；空值统一显示占位线。
const formatDiffValue = (field: string, value: string): string => {
  if (value === '') {
    return '—';
  }
  if (field === 'type' && KNOWN_TYPES.includes(value)) {
    return translate(`transaction_form_type_${value}`);
  }
  return value;
};

const accountLabel = (split: TransactionSplitType): string => {
  const source = split.sourceName ?? '';
  const destination = split.destinationName ?? '';
  if (source && destination && source !== destination) {
    return `${source} → ${destination}`;
  }
  return source || destination;
};

const amountLabel = (split: TransactionSplitType): string => [
  split.amount,
  split.currencyCode,
].filter((part) => typeof part === 'string' && part.length > 0).join(' ');

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <AStackFlex
      row
      justifyContent="space-between"
      alignItems="flex-start"
      style={{ paddingVertical: 3 }}
    >
      <AText fontSize={11} style={{ opacity: 0.6 }}>{label}</AText>
      <AText fontSize={11} numberOfLines={3} textAlign="right" style={{ flex: 1, marginLeft: 12 }}>
        {value || '—'}
      </AText>
    </AStackFlex>
  );
}

function DiffRow({ row }: { row: TransactionDiff }) {
  const { colors } = useThemeColors();

  return (
    <AStackFlex
      row
      alignItems="flex-start"
      style={{
        paddingVertical: 5,
        borderTopWidth: 1,
        borderColor: colors.listBorderColor,
      }}
    >
      <AText fontSize={10} style={{ width: 82, opacity: 0.6 }}>
        {row.split >= 0 ? `#${row.split + 1} ` : ''}
        {fieldLabel(row.field)}
      </AText>
      <AText fontSize={11} style={{ flex: 1 }}>{formatDiffValue(row.field, row.local)}</AText>
      <AText fontSize={11} style={{ flex: 1 }}>{formatDiffValue(row.field, row.server)}</AText>
    </AStackFlex>
  );
}

function ConflictBody({ local, server }: { local: TransactionType; server: TransactionType }) {
  const rows = diffTransaction(local, server);
  if (rows.length === 0) {
    return null;
  }

  return (
    <AView style={{ marginTop: 8 }}>
      <AStackFlex row style={{ paddingBottom: 4 }}>
        <AText fontSize={10} style={{ width: 82 }}> </AText>
        <AText fontSize={10} bold style={{ flex: 1 }}>{translate('sync_notice_local')}</AText>
        <AText fontSize={10} bold style={{ flex: 1 }}>{translate('sync_notice_server')}</AText>
      </AStackFlex>
      {rows.map((row) => (
        <DiffRow key={`${row.field}-${row.split}`} row={row} />
      ))}
    </AView>
  );
}

function DeletionBody({ payload }: { payload: TransactionType }) {
  const splits = payload?.attributes?.transactions;
  if (!Array.isArray(splits) || splits.length === 0) {
    return null;
  }

  return (
    <AView style={{ marginTop: 8 }}>
      {splits.map((split, index) => (
        // payload 里没有 split 级 id，描述 + 下标足以做稳定的渲染 key。
        <AView key={`${index}-${split.description ?? ''}`} style={{ marginTop: index === 0 ? 0 : 10 }}>
          {splits.length > 1 ? (
            <AText fontSize={10} style={{ opacity: 0.6 }}>{`#${index + 1}`}</AText>
          ) : null}
          <InfoRow label={translate('transaction_form_date_label')} value={dateLabel(split.date)} />
          <InfoRow label={translate('transaction_form_description_label')} value={split.description} />
          <InfoRow label={translate('transaction_form_amount_label')} value={amountLabel(split)} />
          <InfoRow label={translate('transaction_form_sourceAccount_label')} value={accountLabel(split)} />
          <InfoRow
            label={translate('transaction_form_category_label')}
            value={split.categoryName || translate('no_category')}
          />
          <InfoRow
            label={translate('transaction_form_tags_label')}
            value={(split.tags ?? []).join(', ')}
          />
        </AView>
      ))}
    </AView>
  );
}

// 连接告警的虚拟条目：数据全部来自 meta 与同步摘要，不落 notices 表。
// 只存「事实」（时间、错误、已确认档位），档位与是否提醒由当前时钟派生：
// 应用一直开着时，跨档与 24h 重提醒都要能自己发生，不能只在同步/网络事件里重算。
type ConnectionAlertState = {
  lastSyncedAt: string | null;
  lastError: string | null;
  pending: number;
  acknowledgedLevel: number;
  acknowledgedAt: string | null;
};

type ConnectionAlertView = ConnectionAlertState & {
  level: ConnectionAlertLevel;
  days: number | null;
  shouldShow: boolean;
};

// 错误分类 → 词条。meta 里存的是固定枚举；未知值统一回落到通用的「同步出错」，
// 不把内部枚举直接展示给用户。
const SYNC_ERROR_LABELS: Record<string, string> = {
  network: 'sync_error_network',
  auth: 'sync_error_auth',
  server: 'sync_error_server',
  incomplete: 'sync_error_incomplete',
};

const syncErrorLabel = (value: string): string => translate(
  SYNC_ERROR_LABELS[value] ?? 'sync_status_error',
);

// 每次渲染都按 now 重算：跨过 3/7 天档位立即升级，同档位超过 24h 再提醒一次。
const evaluateConnectionAlert = (
  alert: ConnectionAlertState,
  now: Date,
): ConnectionAlertView => {
  const level = connectionAlertLevel(alert.lastSyncedAt, now);
  return {
    ...alert,
    level,
    days: daysSinceLastSync(alert.lastSyncedAt, now),
    shouldShow: shouldShowConnectionAlert(
      level,
      alert.acknowledgedLevel,
      alert.acknowledgedAt,
      now,
    ),
  };
};

// busyId 里代表虚拟条目（真实 notice 用 uuid，不会撞上）。
const CONNECTION_ALERT_ID = '__connection_alert__';

// meta 里存的是字符串；非法值按 0 处理，等价于「从未确认过这一档」。
const parseLevel = (raw: string | null): number => {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) ? value : 0;
};

const timestampLabel = (value: string | null): string => {
  if (!value) {
    return '';
  }
  // last_synced_at 是 UTC ISO 串：moment 转成本地时区，和状态条的 HH:mm 同源。
  const parsed = moment(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : '';
};

function ConnectionAlertBody({ alert }: { alert: ConnectionAlertState }) {
  return (
    <AView style={{ marginTop: 6 }}>
      <InfoRow
        label={translate('sync_connection_last_success')}
        value={timestampLabel(alert.lastSyncedAt)}
      />
      {alert.lastError ? (
        // 值是固定的错误分类（network / server / auth / incomplete），只用于选词条，
        // 不把枚举原文展示给用户。
        <InfoRow label={translate('sync_status_error')} value={syncErrorLabel(alert.lastError)} />
      ) : null}
      <AText fontSize={11} style={{ marginTop: 3, opacity: 0.6 }}>
        {translate('sync_connection_pending', { count: alert.pending })}
      </AText>
    </AView>
  );
}

export default function SyncNoticeModal() {
  const { colors } = useThemeColors();
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  // 连接告警的虚拟条目：只会由库里的 meta 与摘要算出来，不存在 notices 表里。
  const [connectionAlert, setConnectionAlert] = useState<ConnectionAlertState | null>(null);
  // 告警的档位与 24h 重提醒只依赖时钟：应用常开时靠这个 now 自己推进，
  // 不必等下一次同步或网络变化。
  const [now, setNow] = useState(() => new Date());
  const [online, setOnline] = useState<boolean>(() => isOnline());
  const [busyId, setBusyId] = useState<string | null>(null);
  // 确认失败的原因只保留一条通用文案：库写失败时卡片必须留在屏幕上并明确告诉用户，
  // 不能吞掉错误让界面看起来「没反应」。
  const [error, setError] = useState<string | null>(null);
  // 同一帧内的第二次点击不会立刻反映到 busyId（state 更新是异步的），用 ref 兜底。
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // 多次 load 可能乱序返回（同步事件连着来）：只让最后一次写入 state。
    let generation = 0;

    const load = async () => {
      generation += 1;
      const current = generation;
      try {
        const db = getDb();
        const scopeId = await getCurrentScope(db);
        const next = await listOpenNotices(db, scopeId);
        if (!cancelled && current === generation) {
          setNotices(next);
        }
      } catch {
        // 库未就绪或账号已删除：保留当前列表，等下一次事件再读，
        // 避免把「读失败」误判成「没有提示」而让弹窗闪一下消失。
      }
    };

    // 告警与 notices 分开读：任何一边失败都不该影响另一边。
    // 独立的 generation：确认告警后紧接一次重读，早发出的旧结果不能把「已确认」覆盖回「该提醒」。
    let alertGeneration = 0;
    const loadAlert = async () => {
      alertGeneration += 1;
      const current = alertGeneration;
      // 连接正常且上一轮没失败：告警不可能显示，跳过这几条查询。
      if (isOnline() && !isSyncFailing(getSyncState())) {
        if (!cancelled) {
          setConnectionAlert(null);
        }
        return;
      }
      try {
        const db = getDb();
        const scopeId = await getCurrentScope(db);
        if (cancelled || !scopeId) {
          return;
        }
        // 待上传数量与 last_synced_at 复用状态条那套有界查询，不新增 SQL。
        const summary = await readSyncSummary(db, scopeId, isOnline());
        const [levelRaw, acknowledgedAt, lastError] = await Promise.all([
          getMeta(db, scopeId, CONNECTION_ALERT_LEVEL_META_KEY),
          getMeta(db, scopeId, CONNECTION_ALERT_ACKNOWLEDGED_AT_META_KEY),
          getMeta(db, scopeId, LAST_SYNC_ERROR_META_KEY),
        ]);
        if (!cancelled && current === alertGeneration) {
          setConnectionAlert({
            lastSyncedAt: summary.lastSyncedAt,
            lastError,
            pending: summary.pending,
            acknowledgedLevel: parseLevel(levelRaw),
            acknowledgedAt,
          });
        }
      } catch {
        // 读不到就保留上一次的结果：不因为一次读失败把告警「撤销」。
      }
    };

    const loadAll = () => {
      load();
      loadAlert();
    };

    loadAll();
    const unsubscribeSync = subscribeSyncChanged(loadAll);
    // 网络恢复/断开都要重算：告警只在离线或同步失败时出现。
    const unsubscribeNetwork = subscribeNetwork((next) => {
      setOnline(next);
      loadAlert();
    });
    // 轻量重判定：只刷新 now，不重读库。每分钟一次，外加应用回到前台时立即刷新，
    // 覆盖「常开应用跨过 3/7 天档位」与「同档位满 24h 再提醒」。
    const refreshNow = () => setNow(new Date());
    const timer = setInterval(refreshNow, 60 * 1000);
    const appStateSubscription = AppState.addEventListener('change', refreshNow);

    return () => {
      cancelled = true;
      clearInterval(timer);
      appStateSubscription.remove();
      unsubscribeSync();
      unsubscribeNetwork();
    };
  }, []);

  // 派生值放在渲染里算：now 变化即得到新的档位与 shouldShow，不需要额外一轮 IO。
  const evaluatedAlert = connectionAlert === null
    ? null
    : evaluateConnectionAlert(connectionAlert, now);

  const handleAcknowledge = async (id: string) => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusyId(id);
    // 每次尝试前清掉上一次的失败提示：成功后不留错误，失败时会在 catch 里重新出现。
    setError(null);
    try {
      const db = getDb();
      const scopeId = await getCurrentScope(db);
      await acknowledgeNotice(db, id, scopeId);
      // 广播后由上面的订阅重读列表：最后一条被确认时 notices 变空，Modal 自动卸载。
      emitSyncChanged();
    } catch {
      // 写失败时弹窗与列表保持不变（不假装已关闭），按钮在 finally 里恢复可用以便重试。
      setError(translate('error_widget_title'));
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  };

  // 关闭连接告警：记下「这一档已经看过」的时间。两条 meta 同事务写入，
  // 避免只写一半时出现「档位记了、时间没记」而反复弹窗。
  const handleAcknowledgeConnectionAlert = async () => {
    if (busyRef.current || !evaluatedAlert) {
      return;
    }
    busyRef.current = true;
    setBusyId(CONNECTION_ALERT_ID);
    setError(null);
    try {
      const db = getDb();
      const scopeId = await getCurrentScope(db);
      await db.tx(async () => {
        await setMeta(db, scopeId, CONNECTION_ALERT_LEVEL_META_KEY, String(evaluatedAlert.level));
        await setMeta(
          db,
          scopeId,
          CONNECTION_ALERT_ACKNOWLEDGED_AT_META_KEY,
          new Date().toISOString(),
        );
      });
      // 与 notices 同一条广播：订阅方重读后 shouldShow 变 false，条目自动消失。
      emitSyncChanged();
    } catch {
      setError(translate('error_widget_title'));
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  };

  // 只在「连不上」的时候打扰用户：离线，或状态机停在 error。
  const alertVisible = evaluatedAlert !== null
    && evaluatedAlert.shouldShow
    && (!online || isSyncFailing(getSyncState()));

  if (notices.length === 0 && !alertVisible) {
    return null;
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      // Android 返回键不关闭：提示只能由用户逐条点「关闭」后消失。
      onRequestClose={() => {}}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.45)',
          justifyContent: 'center',
          paddingHorizontal: 20,
        }}
      >
        {/* 背景刻意不挂 onPress：点击空白处不关闭弹窗（spec §7.8）。 */}
        <View
          testID="sync_notice_card"
          // iOS 上把 VoiceOver 限制在卡片内，不朗读弹窗背后的页面内容。
          accessibilityViewIsModal
          style={{
            backgroundColor: colors.tileBackgroundColor,
            borderRadius: 16,
            padding: 16,
            maxHeight: D_HEIGHT * 0.75,
          }}
        >
          {error ? (
            <View testID="sync_notice_error">
              <AText color={colors.red} fontSize={12} style={{ marginBottom: 4 }}>
                {error}
              </AText>
            </View>
          ) : null}
          <ScrollView
            style={{ flexGrow: 0, flexShrink: 1 }}
            contentContainerStyle={{ paddingBottom: 2 }}
            showsVerticalScrollIndicator={false}
          >
            {alertVisible && evaluatedAlert ? (
              <View testID="sync_connection_alert" style={{ marginTop: 8 }}>
                <AText fontSize={15} bold>
                  {translate('sync_connection_alert', { count: evaluatedAlert.days ?? 0 })}
                </AText>

                <ConnectionAlertBody alert={evaluatedAlert} />

                <AButton
                  testID="sync_connection_close"
                  type="primary"
                  disabled={busyId === CONNECTION_ALERT_ID}
                  onPress={handleAcknowledgeConnectionAlert}
                  accessibilityRole="button"
                  accessibilityLabel={translate('sync_notice_close')}
                  style={{ height: 44, marginTop: 12, marginBottom: 0 }}
                >
                  <AText fontSize={13} bold>{translate('sync_notice_close')}</AText>
                </AButton>
              </View>
            ) : null}
            {notices.map((notice, index) => (
              <AView
                key={notice.id}
                style={{ marginTop: index === 0 ? (alertVisible ? 20 : 8) : 20 }}
              >
                <AText fontSize={15} bold>
                  {translate(notice.kind === 'conflict' ? 'sync_conflict_title' : 'sync_deletion_title')}
                </AText>

                {notice.kind === 'conflict' && notice.localPayload ? (
                  <ConflictBody local={notice.localPayload} server={notice.serverPayload} />
                ) : null}

                {notice.kind === 'server_deletion' ? (
                  <DeletionBody payload={notice.serverPayload} />
                ) : null}

                <AButton
                  testID={`sync_notice_close_${notice.id}`}
                  type="primary"
                  disabled={busyId === notice.id}
                  onPress={() => handleAcknowledge(notice.id)}
                  accessibilityRole="button"
                  accessibilityLabel={translate('sync_notice_close')}
                  // 触控目标至少 44pt；失败后按钮恢复可用，可直接重试。
                  style={{ height: 44, marginTop: 12, marginBottom: 0 }}
                >
                  <AText fontSize={13} bold>{translate('sync_notice_close')}</AText>
                </AButton>
              </AView>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
