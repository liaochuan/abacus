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

// 提示弹窗的词条必须 15 种语言齐全：缺一条 i18n-js 会回退到 en-US，
// 用户会在中文界面里看到英文标题，所以这里做完整性守护。
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

const KEYS = [
  'sync_conflict_title',
  'sync_deletion_title',
  'sync_notice_close',
  'sync_notice_local',
  'sync_notice_server',
  'sync_notice_split_only_local',
  'sync_notice_split_only_server',
  // 连接异常告警是弹窗里的虚拟条目，与真实提示共用同一个卡片。
  'sync_connection_alert',
  'sync_connection_last_success',
  'sync_connection_pending',
  // 错误分类必须翻译后再展示，不能把枚举原文直接给用户。
  'sync_error_network',
  'sync_error_auth',
  'sync_error_server',
  'sync_error_incomplete',
] as const;

test('全部 15 种语言都存在提示弹窗词条', () => {
  expect(Object.keys(translations)).toHaveLength(15);
  Object.entries(translations).forEach(([locale, module]) => {
    KEYS.forEach((key) => {
      expect(typeof module[key]).toBe('string');
      expect(module[key]).not.toBe('');
      // 便于定位是哪个语言缺失
      expect({ [locale]: module[key] }).toHaveProperty(locale);
    });
  });
});

// 失败项列表（04-T5）：原因文案与两个动作按钮同样必须在 15 种语言里都存在，
// 否则用户会看到 `transaction_needs_fix` 这样的原始 key。
const ISSUE_KEYS = [
  'transaction_needs_fix',
  'transaction_gone_on_server',
  'transaction_waiting_network',
  'sync_issue_retry',
  'sync_issue_drop',
  'sync_issue_empty',
  'sync_issue_drop_confirm',
] as const;

test('全部 15 种语言都存在失败项处理词条', () => {
  Object.entries(translations).forEach(([locale, module]) => {
    ISSUE_KEYS.forEach((key) => {
      expect(typeof module[key]).toBe('string');
      expect(module[key]).not.toBe('');
      expect({ [locale]: module[key] }).toHaveProperty(locale);
    });
  });
});

test('失败项原因与按钮的 en-US / zh-CN 文案', () => {
  expect(enUS.transaction_needs_fix).toBe('Needs a fix before it can sync');
  expect(enUS.transaction_gone_on_server).toBe('Deleted on the server');
  expect(enUS.transaction_waiting_network).toBe('Waiting for a network connection');
  expect(enUS.sync_issue_retry).toBe('Retry');
  expect(enUS.sync_issue_drop).toBe('Discard local changes');
  expect(enUS.sync_issue_empty).toBe('Nothing needs attention');
  expect(enUS.sync_issue_drop_confirm).toBe('Discard these local changes?');

  expect(zhCN.transaction_needs_fix).toBe('需要修正后才能同步');
  expect(zhCN.transaction_gone_on_server).toBe('已在服务端删除');
  expect(zhCN.transaction_waiting_network).toBe('等待网络恢复');
  expect(zhCN.sync_issue_retry).toBe('重试');
  expect(zhCN.sync_issue_drop).toBe('放弃本地改动');
  expect(zhCN.sync_issue_empty).toBe('没有需要处理的项');
  expect(zhCN.sync_issue_drop_confirm).toBe('放弃这些本地改动？');
});

test('en-US 与 zh-CN 的关键文案', () => {
  expect(enUS.sync_conflict_title).toBe('Transaction conflict');
  expect(enUS.sync_deletion_title).toBe('Deleted on server');
  expect(enUS.sync_notice_close).toBe('Close');
  expect(enUS.sync_notice_local).toBe('Local');
  expect(enUS.sync_notice_server).toBe('Server');

  expect(zhCN.sync_conflict_title).toBe('交易冲突');
  expect(zhCN.sync_deletion_title).toBe('已在服务端删除');
  expect(zhCN.sync_notice_close).toBe('关闭');
  expect(zhCN.sync_notice_local).toBe('本地');
  expect(zhCN.sync_notice_server).toBe('服务端');
});

test('连接告警的档位文案保留计数占位符', () => {
  expect(enUS.sync_connection_alert).toContain('%{count}');
  expect(zhCN.sync_connection_alert).toContain('%{count}');
  expect(enUS.sync_connection_pending).toContain('%{count}');
  expect(zhCN.sync_connection_pending).toContain('%{count}');
  expect(enUS.sync_connection_last_success).toBe('Last successful sync');
  expect(zhCN.sync_connection_last_success).toBe('上次成功同步');
});

test('错误分类在 en-US / zh-CN 都有可读文案', () => {
  expect(enUS.sync_error_network).toBe('Network error');
  expect(enUS.sync_error_auth).toBe('Sign-in expired');
  expect(enUS.sync_error_server).toBe('Server error');
  expect(enUS.sync_error_incomplete).toBe('Sync incomplete');

  expect(zhCN.sync_error_network).toBe('网络异常');
  expect(zhCN.sync_error_auth).toBe('登录已过期');
  expect(zhCN.sync_error_server).toBe('服务端错误');
  expect(zhCN.sync_error_incomplete).toBe('同步未完成');
});
