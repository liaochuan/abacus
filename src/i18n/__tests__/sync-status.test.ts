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

// 状态条是全局常驻组件：任何语言缺一条词条都会把 key 直接显示给用户。

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

const syncStatusKeys = [
  'sync_status_synced',
  'sync_status_offline',
  'sync_status_syncing',
  'sync_status_pending',
  'sync_status_problems',
  // 同步失败时状态条不能继续显示「已同步」（见 statusBarText 的优先级）。
  'sync_status_error',
] as const;

test('全部 15 种语言都存在状态条词条', () => {
  expect(Object.keys(translations)).toHaveLength(15);

  Object.entries(translations).forEach(([locale, module]) => {
    syncStatusKeys.forEach((key) => {
      expect(typeof module[key]).toBe('string');
      expect(module[key]).not.toBe('');
      // 便于定位是哪个语言缺失
      expect({ [locale]: module[key] }).toHaveProperty(locale);
    });
  });
});

test('en-US / zh-CN 的状态条文案带计数占位符', () => {
  expect(enUS.sync_status_synced).toBe('Synced');
  expect(zhCN.sync_status_synced).toBe('已同步');
  expect(zhCN.sync_status_pending).toContain('%{count}');
  expect(zhCN.sync_status_problems).toContain('%{count}');
  expect(enUS.sync_status_pending).toContain('%{count}');
  expect(enUS.sync_status_problems).toContain('%{count}');
});

test('同步失败的文案', () => {
  expect(enUS.sync_status_error).toBe('Sync error');
  expect(zhCN.sync_status_error).toBe('同步出错');
});
