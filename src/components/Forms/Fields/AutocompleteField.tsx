import React, {
  useCallback, useMemo, useRef, useState,
} from 'react';
import axios from 'axios';
import { useSelector } from 'react-redux';

import { AntDesign, EvilIcons } from '@expo/vector-icons';
import { RootState } from '../../../store';
import { convertKeysToCamelCase, useThemeColors } from '../../../lib/common';
import translate from '../../../i18n/locale';
import {
  filterAutocomplete, filterAutocompleteByTypes, readAutocomplete,
} from '../../../db/autocomplete';
import type { AutocompleteKind, AutocompleteOption } from '../../../db/autocomplete';
import { getDb } from '../../../db/instance';
import { getCurrentScope } from '../../../db/scope';
import {
  AInput,
  APressable,
  AStack,
  AText,
  AView,
  ALabel,
  AFormView, AIconButton,
} from '../../UI/ALibrary';

type AutocompleteType = AutocompleteOption;

type OfflineCache = {
  scopeId: string;
  kind: AutocompleteKind;
  options: AutocompleteOption[];
};

// 有离线缓存的自动补全体；descriptions（routeApi="transactions"）没有缓存，离线时只保留自由输入。
const OFFLINE_KINDS: AutocompleteKind[] = ['accounts', 'categories', 'budgets', 'bills', 'tags'];

const offlineKindOf = (routeApi: string): AutocompleteKind | null => (
  OFFLINE_KINDS.includes(routeApi as AutocompleteKind) ? routeApi as AutocompleteKind : null
);

// 账户类型过滤的线上规则：designation-splitType 决定首选类型，再并上 Loan/Debt/Mortgage。
// 离线用同一套名单过滤缓存，保证「所有账户类型」与「表单允许的类型」一致。
const ACCOUNT_TYPE_BY_SPLIT: Record<string, string> = {
  'source-withdrawal': 'Asset account',
  'destination-withdrawal': 'Expense account',
  'source-deposit': 'Revenue account',
  'destination-deposit': 'Asset account',
  'source-transfer': 'Asset account',
  'destination-transfer': 'Asset account',
};

const accountTypesOf = (designation: string, splitType: string): string[] => {
  const primary = ACCOUNT_TYPE_BY_SPLIT[`${designation}-${splitType}`];
  return primary === undefined ? [] : [primary, 'Loan', 'Debt', 'Mortgage'];
};

export default function AutocompleteField({
  splitType = 'withdrawal',
  designation = 'source',
  isRequired = false,
  label,
  placeholder,
  value,
  onChangeText = null,
  onSelectAutocomplete,
  InputRightElement = null,
  routeApi,
  onDeleteMultiple = null,
  multiple = false,
  small = false,
  offline = false,
}) {
  const { colors } = useThemeColors();
  const backendURL = useSelector((state: RootState) => state.configuration.backendURL);
  const [multipleValue, setMultipleValue] = useState('');
  const [autocompletes, setAutocompletes] = useState<AutocompleteType[]>([]);
  // 「缓存本身为空」与「过滤后为空」是两回事：只有前者才提示用户去同步。
  const [cacheEmpty, setCacheEmpty] = useState(false);
  const [displayAutocomplete, setDisplayAutocomplete] = useState(false);

  // 解析后的候选按 (scopeId, kind) 缓存：一次聚焦只读一次 blob，击键全在内存里过滤。
  const cacheRef = useRef<OfflineCache | null>(null);
  // 同 kind 的并发读取合并成一个 promise，避免慢读期间连续击键触发多次 blob 解析。
  const inflightRef = useRef<{ kind: AutocompleteKind; promise: Promise<AutocompleteOption[]> } | null>(null);
  const scopeRef = useRef('');
  // 请求序号：慢的旧请求回来时直接丢弃，避免覆盖新输入的结果。
  const requestRef = useRef(0);

  const readOfflineOptions = useCallback((kind: AutocompleteKind): Promise<AutocompleteOption[]> => {
    const cached = cacheRef.current;
    if (cached !== null && cached.kind === kind && cached.scopeId === scopeRef.current) {
      return Promise.resolve(cached.options);
    }
    const inflight = inflightRef.current;
    if (inflight !== null && inflight.kind === kind) {
      return inflight.promise;
    }
    const promise = (async () => {
      const db = getDb();
      const scopeId = await getCurrentScope(db);
      scopeRef.current = scopeId;
      const options = await readAutocomplete(db, scopeId, kind);
      cacheRef.current = { scopeId, kind, options };
      return options;
    })();
    inflightRef.current = { kind, promise };
    // 成功/失败都清掉 in-flight 标记：失败时下一次击键可以重试。
    const clearInflight = () => {
      if (inflightRef.current?.promise === promise) {
        inflightRef.current = null;
      }
    };
    promise.then(clearInflight, clearInflight);
    return promise;
  }, []);

  const refreshAutocomplete = useCallback(async (query: string) => {
    const limit = 10;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    if (offline) {
      const kind = offlineKindOf(routeApi);
      if (kind === null) {
        setAutocompletes([]);
        setCacheEmpty(true);
        return;
      }
      let options: AutocompleteOption[] = [];
      try {
        options = await readOfflineOptions(kind);
      } catch {
        // DB 未初始化或读取失败：退化为「没有候选」，不阻断手动输入。
        options = [];
      }
      if (requestRef.current !== requestId) {
        return;
      }
      setCacheEmpty(options.length === 0);
      const types = routeApi === 'accounts' ? accountTypesOf(designation, splitType) : [];
      setAutocompletes(filterAutocomplete(filterAutocompleteByTypes(options, types), query, limit));
      return;
    }

    const accountTypes = routeApi === 'accounts' ? accountTypesOf(designation, splitType) : [];
    const types = accountTypes.length > 0
      ? `&types=${accountTypes.map((type) => encodeURIComponent(type)).join(',')}`
      : '';
    const response = await axios.get(`${backendURL}/api/v1/autocomplete/${routeApi}?limit=${limit}${types}&query=${encodeURIComponent(query)}`);
    if (requestRef.current !== requestId) {
      return;
    }
    setCacheEmpty(false);
    setAutocompletes(convertKeysToCamelCase(response.data) as AutocompleteType[]);
  }, [offline, routeApi, backendURL, designation, splitType, readOfflineOptions]);

  const handleChangeText = useCallback((text: string) => {
    if (multiple) {
      setMultipleValue(text);
    } else if (onChangeText !== null) {
      onChangeText(text);
    }
    refreshAutocomplete(text);
  }, [multiple, onChangeText, refreshAutocomplete]);

  const handleSelectAutocomplete = useCallback(async (autocomplete: AutocompleteType) => {
    onSelectAutocomplete(autocomplete);
    if (multiple) {
      await refreshAutocomplete('');
      setMultipleValue('');
    } else {
      setDisplayAutocomplete(false);
    }
  }, [onSelectAutocomplete, multiple, refreshAutocomplete]);

  const handleDeleteMultiple = useCallback((item) => {
    onDeleteMultiple(item);
  }, [onDeleteMultiple]);

  const handleFocus = useCallback(() => {
    // 每次聚焦重新校验缓存：切账号后 scope 变化能立即反映，同一次输入过程则复用内存结果。
    cacheRef.current = null;
    inflightRef.current = null;
    setDisplayAutocomplete(true);
    refreshAutocomplete(value && !small && !multiple ? value : '');
  }, [refreshAutocomplete, value, small, multiple]);

  const handleBlur = useCallback(() => {
    setDisplayAutocomplete(false);
  }, []);

  return useMemo(
    () => (
      <AFormView>
        {!small && (
          <ALabel isRequired={isRequired}>
            {label}
          </ALabel>
        )}

        {multiple && (value.map((item: string, index: number) => (
          <AView key={`${index + 1}${item}`} style={{ width: '100%' }}>
            <AView
              style={{
                height: 30,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'flex-start',
                borderRadius: 10,
                paddingHorizontal: 0,
                marginBottom: 5,
                backgroundColor: colors.brandNeutralFix,
              }}
            >
              <EvilIcons name="tag" size={24} color={colors.brandDark} />
              <AText px={5} fontSize={15} lineHeight={20} color={colors.brandDark} numberOfLines={1} maxWidth={200} bold>{item}</AText>
              <AIconButton
                icon={<AntDesign name="close-circle" size={19} color={colors.greyLight} />}
                onPress={() => handleDeleteMultiple(item)}
              />
            </AView>
          </AView>
        )))}

        <AInput
          height={40}
          returnKeyType="done"
          onSubmitEditing={({ nativeEvent: { text } }) => ((multiple && text !== '') ? handleSelectAutocomplete({ name: text, id: '' }) : null)}
          placeholder={placeholder}
          value={!multiple ? value : multipleValue}
          onChangeText={handleChangeText}
          onFocus={handleFocus}
          onBlur={handleBlur}
          InputRightElement={InputRightElement}
        />

        {displayAutocomplete && (
          <AView style={{ maxWidth: '100%' }}>
            {autocompletes.map((autocomplete: AutocompleteType) => (
              <APressable
                style={{ borderRadius: 10, paddingLeft: 5 }}
                key={autocomplete.id || autocomplete.name}
                onPress={() => handleSelectAutocomplete(autocomplete)}
              >
                <AStack
                  justifyContent="space-between"
                  mx={5}
                  my={5}
                >
                  <AText fontSize={15} numberOfLines={1} underline>
                    {autocomplete.name || '-'}
                  </AText>
                </AStack>
              </APressable>
            ))}
            {offline && routeApi === 'accounts' && cacheEmpty && (
              <AText px={5} py={5} fontSize={13} numberOfLines={2}>
                {translate('offline_no_accounts')}
              </AText>
            )}
          </AView>
        )}
      </AFormView>
    ),
    [
      colors,
      isRequired,
      label,
      placeholder,
      multiple,
      value,
      designation,
      small,
      splitType,
      offline,
      routeApi,
      backendURL,
      InputRightElement,
      multipleValue,
      autocompletes,
      cacheEmpty,
      displayAutocomplete,
      handleChangeText,
      handleFocus,
      handleBlur,
      handleSelectAutocomplete,
      handleDeleteMultiple,
    ],
  );
}
