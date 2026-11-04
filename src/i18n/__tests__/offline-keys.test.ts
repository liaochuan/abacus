import deDE from '../locale/translations/de-DE';
import enUS from '../locale/translations/en-US';
import esES from '../locale/translations/es-ES';
import frFR from '../locale/translations/fr-FR';
import idID from '../locale/translations/id-ID';
import itIT from '../locale/translations/it-IT';
import jaJP from '../locale/translations/ja-JP';
import koKR from '../locale/translations/ko-KR';
import ptBR from '../locale/translations/pt-BR';
import ruRU from '../locale/translations/ru-RU';
import slSI from '../locale/translations/sl-SI';
import trTR from '../locale/translations/tr-TR';
import ukUA from '../locale/translations/uk-UA';
import viVN from '../locale/translations/vi-VN';
import zhCN from '../locale/translations/zh-CN';

const translations: Record<string, Record<string, string>> = {
  'de-DE': deDE,
  'en-US': enUS,
  'es-ES': esES,
  'fr-FR': frFR,
  'id-ID': idID,
  'it-IT': itIT,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'pt-BR': ptBR,
  'ru-RU': ruRU,
  'sl-SI': slSI,
  'tr-TR': trTR,
  'uk-UA': ukUA,
  'vi-VN': viVN,
  'zh-CN': zhCN,
};

// 离线同步相关的文案 key（见 offline-sync 计划的 Task 6）。
const OFFLINE_KEYS = [
  'offline_data_stale',
  'offline_write_blocked',
  'offline_no_accounts',
  'sync_status_synced',
  'sync_status_offline',
  'sync_status_syncing',
  'sync_status_pending',
  'sync_status_problems',
  'sync_status_error',
  'sync_connection_alert',
  'sync_connection_last_success',
  'sync_connection_pending',
  'sync_conflict_title',
  'sync_deletion_title',
  'sync_notice_close',
  'sync_notice_local',
  'sync_notice_server',
  'sync_error_network',
  'sync_error_auth',
  'sync_error_server',
  'sync_error_incomplete',
  'transaction_needs_fix',
  'transaction_gone_on_server',
  'transaction_waiting_network',
  'sync_issue_retry',
  'sync_issue_drop',
  'sync_issue_empty',
  'sync_issue_drop_confirm',
  'sync_issue_reload',
  // 设置页的同步入口（04-T7）。
  'sync_settings_title',
  'sync_settings_sync_now',
  'sync_settings_issues',
  'sync_settings_reset',
  'sync_settings_reset_warning',
  'sync_settings_reset_confirm_title',
  'sync_settings_reset_confirm_message',
  'sync_settings_busy',
] as const;

const locales = Object.keys(translations);

test('当前覆盖全部 15 种语言', () => {
  expect(locales).toHaveLength(15);
});

describe.each(locales)('%s 的离线文案', (locale) => {
  const module = translations[locale];

  test.each(OFFLINE_KEYS)('%s 存在且非空', (key) => {
    expect(module).toHaveProperty(key);
    expect(typeof module[key]).toBe('string');
    expect(module[key].trim()).not.toBe('');
  });
});

test('en-US 与 zh-CN 的离线文案为正式文案（非占位）', () => {
  expect(enUS.offline_data_stale).toBe('Offline — data may be out of date');
  expect(zhCN.offline_data_stale).toBe('离线 — 数据可能不是最新');
  expect(enUS.offline_write_blocked).toBe('Offline — please reconnect to make changes');
  expect(zhCN.offline_write_blocked).toBe('离线 — 请联网后再修改');
});
