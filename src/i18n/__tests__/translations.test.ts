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

test('全部 15 种语言都存在 offline_data_stale', () => {
  expect(Object.keys(translations)).toHaveLength(15);
  Object.entries(translations).forEach(([locale, module]) => {
    expect(module.offline_data_stale).toBeDefined();
    expect(typeof module.offline_data_stale).toBe('string');
    expect(module.offline_data_stale).not.toBe('');
    // 便于定位是哪个语言缺失
    expect({ [locale]: module.offline_data_stale }).toHaveProperty(locale);
  });
});

test('en-US 的 offline_data_stale 为指定文案', () => {
  expect(enUS.offline_data_stale).toBe('Offline — data may be out of date');
});

test('全部 15 种语言都存在 transaction_load_failed', () => {
  expect(Object.keys(translations)).toHaveLength(15);
  Object.entries(translations).forEach(([locale, module]) => {
    expect(module.transaction_load_failed).toBeDefined();
    expect(typeof module.transaction_load_failed).toBe('string');
    expect(module.transaction_load_failed).not.toBe('');
    expect({ [locale]: module.transaction_load_failed }).toHaveProperty(locale);
  });
  expect(enUS.transaction_load_failed).toBe('Could not read transactions');
  expect(zhCN.transaction_load_failed).toBe('无法读取交易');
});

test('全部 15 种语言都存在 offline_no_accounts', () => {
  expect(Object.keys(translations)).toHaveLength(15);
  Object.entries(translations).forEach(([locale, module]) => {
    expect(module.offline_no_accounts).toBeDefined();
    expect(typeof module.offline_no_accounts).toBe('string');
    expect(module.offline_no_accounts).not.toBe('');
    expect({ [locale]: module.offline_no_accounts }).toHaveProperty(locale);
  });
  expect(enUS.offline_no_accounts).toBe('No cached accounts — connect to sync');
  expect(zhCN.offline_no_accounts).toBe('没有缓存的账户，请联网同步');
});

test('全部 15 种语言都存在交易保存提示文案', () => {
  expect(Object.keys(translations)).toHaveLength(15);
  Object.entries(translations).forEach(([locale, module]) => {
    const keys = ['transaction_saved_pending', 'transaction_saved_synced'] as const;
    keys.forEach((key) => {
      expect(typeof module[key]).toBe('string');
      expect(module[key]).not.toBe('');
      expect({ [locale]: module[key] }).toHaveProperty(locale);
    });
  });
  expect(enUS.transaction_saved_pending).toBe('Saved locally, waiting to sync');
  expect(enUS.transaction_saved_synced).toBe('Saved');
  expect(zhCN.transaction_saved_pending).toBe('已保存到本地，等待同步');
  expect(zhCN.transaction_saved_synced).toBe('已保存');
});
