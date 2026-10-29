import React, {
  useCallback,
  useMemo,
  useLayoutEffect,
  useEffect,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import moment from 'moment';
import { SwipeListView } from 'react-native-swipe-list-view';
import {
  EvilIcons,
  Ionicons,
  MaterialCommunityIcons,
  MaterialIcons,
} from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useDispatch } from 'react-redux';
import {
  CommonActions,
  useFocusEffect,
  useNavigation,
} from '@react-navigation/native';

import { SearchBarCommands } from 'react-native-screens';
import { TransactionSplitType, TransactionType } from '../../models/transactions';
import { RootDispatch } from '../../store';
import translate from '../../i18n/locale';
import { getDb } from '../../db/instance';
import { nextPageOffset } from '../../db/pagination';
import { listTransactions, TransactionQueryFilters, deleteLocalTransaction } from '../../db/repository';
import { getCurrentScope } from '../../db/scope';
import { startOfCurrentQuarter } from '../../lib/dateRange';
import { requestSync } from '../../lib/syncScheduler';
import { useOnlineGuard } from '../../lib/useOnlineGuard';
import { D_WIDTH, localNumberFormat, useThemeColors } from '../../lib/common';
import { ScreenType } from '../../types/screen';
import {
  APressable, AScrollView, AStackFlex, AText, AView,
} from '../UI/ALibrary';
import AFilterButton from '../UI/ALibrary/AFilterButton';
import AButton from '../UI/ALibrary/AButton';
import ADateFilterButton from '../UI/ALibrary/ADateFilterButton';
import SyncStatusBar from '../UI/SyncStatusBar';

const ITEM_HEIGHT = 90;
// 本地分页每页条数。本地库没有廉价 COUNT，total 传 Infinity，翻页靠短页/空页结束。
const PAGE_SIZE = 50;

const resetTransactionsDates = (transactions: TransactionSplitType[]) => transactions.map((t) => ({
  ...t,
  date: new Date().toISOString(),
}));

function ListFooterComponent({ onLoadMore, loading, hasMore }) {
  const { colors } = useThemeColors();

  if (!loading && !hasMore) {
    return null;
  }

  return (
    <AStackFlex
      style={{
        height: ITEM_HEIGHT,
      }}
    >
      {loading && (
      <AStackFlex py={10} px={10}>
        <ActivityIndicator color={colors.text} />
      </AStackFlex>
      )}
      {(!loading && hasMore) && (
        <AButton style={{ height: 40 }} mx={30} onPress={onLoadMore}>
          <AStackFlex row>
            <Ionicons name="cloud-download" size={15} color="white" style={{ margin: 5 }} />
            <AText fontSize={15}>{translate('load_more')}</AText>
          </AStackFlex>
        </AButton>
      )}
    </AStackFlex>
  );
}

function RenderItem({ item }) {
  const { colors } = useThemeColors();
  const navigation = useNavigation();

  const goToEdit = (id: string, payload: { splits: TransactionSplitType[]; groupTitle: string; }) => navigation.dispatch(
    CommonActions.navigate({
      name: 'TransactionDetailScreen',
      params: {
        id,
        payload,
      },
    }),
  );

  const goToDuplicate = (payload: { splits: TransactionSplitType[]; groupTitle: string; }) => navigation.dispatch(
    CommonActions.navigate({
      name: 'TransactionCreateScreen',
      params: {
        payload,
      },
    }),
  );

  const colorItemTypes = {
    withdrawal: {
      bg: colors.brandNeutralLight,
      color: colors.brandNeutral,
      icon: 'arrow-down',
      prefix: '-',
    },
    deposit: {
      bg: colors.brandSuccessLight,
      color: colors.brandSuccess,
      icon: 'arrow-up',
      prefix: '+',
    },
    transfer: {
      bg: colors.brandInfoLight,
      color: colors.brandInfo,
      icon: 'arrow-left-right',
      prefix: '',
    },
    'opening balance': {
      bg: colors.brandNeutralLight,
      color: colors.brandNeutral,
      icon: 'arrow-left-right',
      prefix: '',
    },
  };

  const getTransactionTypeAttributes = (type: string) => {
    if (typeof colorItemTypes[type] === 'undefined') {
      return colorItemTypes.transfer;
    }

    return colorItemTypes[type];
  };

  return useMemo(() => (
    <APressable
      style={{
        height: ITEM_HEIGHT,
        backgroundColor: colors.tileBackgroundColor,
        borderTopWidth: 0.5,
        borderColor: colors.listBorderColor,
        paddingLeft: 10,
      }}
      onPress={() => {
        goToEdit(item.id, {
          splits: item.attributes.transactions,
          groupTitle: item.attributes.groupTitle,
        });
      }}
      onLongPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch();
        goToDuplicate({
          splits: resetTransactionsDates(item.attributes.transactions),
          groupTitle: item.attributes.groupTitle || '',
        });
      }}
    >
      <AStackFlex justifyContent="space-between" alignItems="flex-start" row>
        <AStackFlex justifyContent="flex-start" row>
          <AView
            style={{
              backgroundColor: getTransactionTypeAttributes(item.attributes.transactions[0].type).bg,
              borderRadius: 10,
              marginRight: 8,
              padding: 5,
            }}
          >
            <MaterialCommunityIcons
              name={getTransactionTypeAttributes(item.attributes.transactions[0].type).icon}
              size={24}
              color={getTransactionTypeAttributes(item.attributes.transactions[0].type).color}
            />
          </AView>
          <AStackFlex alignItems="flex-start" py={7}>
            <AText fontSize={14} maxWidth={D_WIDTH - 175} numberOfLines={1} bold>
              {item.attributes.groupTitle}
              {item.attributes.groupTitle?.length > 0 ? ': ' : ''}
              {item.attributes.transactions[0].description}
            </AText>

            <AText fontSize={12} maxWidth={D_WIDTH - 175} numberOfLines={1}>
              {item.attributes.transactions[0].type === 'withdrawal'
                ? item.attributes.transactions[0].sourceName
                : item.attributes.transactions[0].destinationName}
            </AText>

            <AText fontSize={12} maxWidth={D_WIDTH - 175} numberOfLines={1}>
              {`${moment(item.attributes.transactions[0].date).format('LT')}${
                item.attributes.transactions[0].categoryName
                  ? ` • ${item.attributes.transactions[0].categoryName}`
                  : ''
              }`}
            </AText>
            {item.attributes.transactions[0].tags.length > 0 && (
              <AStackFlex justifyContent="flex-start" alignItems="flex-start" row>
                {item.attributes.transactions[0].tags.filter((_, index) => index < 2).map((tag) => (
                  <AView
                    key={tag}
                    style={{
                      height: 15,
                      flexDirection: 'row',
                      justifyContent: 'center',
                      alignItems: 'center',
                      borderRadius: 4,
                      paddingHorizontal: 2,
                      paddingVertical: 0,
                      backgroundColor: colors.brandNeutralFix,
                      marginHorizontal: 2,
                    }}
                  >
                    <EvilIcons name="tag" size={15} color={colors.brandDark} />
                    <AText fontSize={10} color={colors.brandDark} numberOfLines={1} maxWidth={100} bold>{tag}</AText>
                  </AView>
                ))}
              </AStackFlex>
            )}
          </AStackFlex>
        </AStackFlex>
        <AView
          style={{
            borderRadius: 10,
            backgroundColor: getTransactionTypeAttributes(item.attributes.transactions[0].type).bg,
            margin: 10,
            marginTop: 15,
            padding: 5,
          }}
        >
          <AText
            fontSize={15}
            color={getTransactionTypeAttributes(item.attributes.transactions[0].type).color}
            bold
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.8}
          >
            {`${getTransactionTypeAttributes(item.attributes.transactions[0].type).prefix}${localNumberFormat(item.attributes.transactions[0].currencyCode, item.attributes.transactions.reduce((total, split) => total + parseFloat(split.amount), 0))}`}
          </AText>
        </AView>
      </AStackFlex>
    </APressable>
  ), [item, colors]);
}

async function deleteAlert(transaction: TransactionType, rowMap, closeRow, deleteRow, guard) {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch();
  // 离线时删除会失败：本地只读展示，删除交给同步层（尚未支持离线删除）。这里直接拦截，不弹确认框。
  guard(() => Alert.alert(
    translate('transaction_list_alert_title'),
    `${translate('transaction_list_alert_text')}\n`
    + `${transaction?.attributes?.transactions[0]?.description}\n`
    + `${moment(transaction?.attributes?.transactions[0]?.date).format('ll')} • ${transaction?.attributes?.transactions[0]?.categoryName || ''}\n`,
    [
      {
        text: translate('transaction_list_delete_button'),
        onPress: () => deleteRow(transaction?.id),
        style: 'destructive',
      },
      {
        text: translate('transaction_list_cancel_button'),
        onPress: () => closeRow(transaction?.id, rowMap),
        style: 'cancel',
      },
    ],
  ));
}

function RenderHiddenItem({ handleOnPressCopy, handleOnPressDelete, online }) {
  const { colors } = useThemeColors();

  return useMemo(() => (
    <AStackFlex row>
      <APressable
        style={{
          height: ITEM_HEIGHT,
          width: '50%',
          backgroundColor: colors.brandWarning,
          paddingHorizontal: 10,
          borderTopWidth: 0.5,
          borderColor: colors.listBorderColor,
        }}
        onPress={handleOnPressCopy}
      >
        <AStackFlex alignItems="flex-start">
          <AStackFlex style={{ width: 70 }}>
            <MaterialIcons name="content-copy" color="white" size={17} />
            <AText color="white" fontSize={12} bold>
              {translate('transaction_clone')}
            </AText>
          </AStackFlex>
        </AStackFlex>
      </APressable>
      <APressable
        style={{
          height: ITEM_HEIGHT,
          width: '50%',
          backgroundColor: colors.red,
          paddingHorizontal: 10,
          borderTopWidth: 0.5,
          borderColor: colors.listBorderColor,
          // 离线时置灰但仍可点击，点按后由 guard 弹出原因提示。
          opacity: online ? 1 : 0.4,
        }}
        onPress={handleOnPressDelete}
      >
        <AStackFlex alignItems="flex-end">
          <AStackFlex style={{ width: 70 }}>
            <MaterialIcons name="delete" color="white" size={17} />
            <AText color="white" fontSize={12} bold>
              {translate('transaction_delete')}
            </AText>
          </AStackFlex>
        </AStackFlex>
      </APressable>
    </AStackFlex>
  ), [handleOnPressCopy, handleOnPressDelete, online]);
}

export default function TransactionsScreen({ navigation, route }: ScreenType) {
  const { params } = route;
  const { colors } = useThemeColors();
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<boolean>(false);
  const [transactions, setTransactions] = useState<TransactionType[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const generationRef = React.useRef(0);
  const loadingMoreRef = React.useRef(false);
  const [search, setSearch] = useState('');
  const searchInputRef = React.useRef('');
  const [reloadToken, setReloadToken] = useState(0);
  // 首帧就用下钻参数或当前季度起点，避免先查默认区间再查目标区间。
  const [startDate, setStartDate] = useState<Date>(() => params?.startDate ?? startOfCurrentQuarter());
  const [account, setAccount] = useState<string>('');
  const [type, setType] = useState<'' | 'withdrawal' | 'deposit' | 'transfer'>('');
  const [currentCode, setCurrentCode] = useState('');
  // 分类下钻用结构化参数（分类 id / 无分类），不再拼 Firefly 搜索串。
  const [categoryId, setCategoryId] = useState<string | undefined>(params?.categoryId);
  const [hasAnyCategory, setHasAnyCategory] = useState<boolean | undefined>(params?.hasAnyCategory);
  const dispatch = useDispatch<RootDispatch>();
  const { online, guard } = useOnlineGuard();

  const searchBarRef = React.useRef<SearchBarCommands | null>(null);

  // 空字符串一律转成 undefined：该维度不参与筛选。
  const filters = useMemo<TransactionQueryFilters>(() => ({
    start: moment(startDate).format('YYYY-MM-DD'),
    type: type === '' ? undefined : type,
    currencyCode: currentCode === '' ? undefined : currentCode,
    account: account === '' ? undefined : account,
    text: search === '' ? undefined : search,
    categoryId,
    hasAnyCategory,
  }), [account, categoryId, currentCode, hasAnyCategory, search, startDate, type]);

  // 首屏与筛选变化时从 offset 0 重读；generation 用于丢弃过期结果（含加载更多）。
  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    const load = async () => {
      setLoading(true);
      try {
        const db = getDb();
        const scopeId = await getCurrentScope(db);
        const page = await listTransactions(db, scopeId, { ...filters, limit: PAGE_SIZE, offset: 0 });
        if (generation !== generationRef.current) {
          return;
        }
        setTransactions(page.map((record) => record.payload));
        setError(false);
        // 本地库没有廉价 COUNT：total 传 Infinity，翻页在短页/空页时结束。
        setNextOffset(nextPageOffset(
          { offset: 0, limit: PAGE_SIZE, received: page.length },
          Number.POSITIVE_INFINITY,
        ));
      } catch {
        if (generation !== generationRef.current) {
          return;
        }
        // 读取失败保留现有列表（可能为空），并给出可见提示，避免误当成"没有交易"。
        setError(true);
        setNextOffset(null);
      } finally {
        if (generation === generationRef.current) {
          setLoading(false);
        }
      }
    };

    load();
  }, [filters, reloadToken]);

  const onLoadMore = async () => {
    if (nextOffset === null || loadingMoreRef.current) {
      return;
    }
    const generation = generationRef.current;
    const offset = nextOffset;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const db = getDb();
      const scopeId = await getCurrentScope(db);
      const page = await listTransactions(db, scopeId, { ...filters, limit: PAGE_SIZE, offset });
      if (generation !== generationRef.current) {
        return;
      }
      setTransactions((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const additions = page
          .map((record) => record.payload)
          .filter((item) => !seen.has(item.id));
        return [...prev, ...additions];
      });
      setError(false);
      setNextOffset(nextPageOffset(
        { offset, limit: PAGE_SIZE, received: page.length },
        Number.POSITIVE_INFINITY,
      ));
    } catch {
      if (generation === generationRef.current) {
        setError(true);
        setNextOffset(null);
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  // 下拉刷新：先发起后台同步（不阻塞动画），同时重查本地列表。
  const manualRefresh = useCallback(() => {
    requestSync('manual').catch(() => {});
    reload();
  }, [reload]);

  // 搜索栏输入只写 ref；blur/回车时提交并重新查询本地库。
  const applySearch = useCallback(() => {
    setSearch(searchInputRef.current.trim());
    setReloadToken((token) => token + 1);
  }, []);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        ref: searchBarRef,
        autoCapitalize: 'none',
        placeholder: translate('transaction_search_placeholder'),
        headerIconColor: colors.text,
        textColor: colors.text,
        hintTextColor: colors.text,
        onChangeText: (event) => {
          searchInputRef.current = event.nativeEvent.text;
        },
        onBlur: () => applySearch(),
        onSearchButtonPress: () => applySearch(),
        disableBackButtonOverride: true,
        shouldShowHintSearchIcon: false,
      },
    });
  }, [applySearch, colors, navigation]);

  useFocusEffect(
    useCallback(() => {
      if (params?.forceRefresh === true) {
        reload();
        navigation.setParams({ forceRefresh: false });
      }

      // 分类下钻参数消费一次后清掉，避免下次进入重复应用。
      if (params?.categoryId !== undefined || params?.hasAnyCategory !== undefined) {
        setCategoryId(params?.categoryId);
        setHasAnyCategory(params?.hasAnyCategory);
        navigation.setParams({ categoryId: undefined, hasAnyCategory: undefined });
      }

      if (params?.startDate !== undefined) {
        setStartDate(params.startDate);
        navigation.setParams({ startDate: undefined });
      }
    }, [navigation, params, reload]),
  );

  const closeRow = (rowKey: string | number, rowMap: { [x: string]: { closeRow: () => void; }; }) => {
    if (rowMap[rowKey]) {
      rowMap[rowKey].closeRow();
    }
  };

  // 列表读的是本地库：只删服务端不够，本地行留着会在重载/对账后重新出现。
  // 先等服务端删除成功，再清本地行（`deleteLocalTransaction` 只删 dirty = 0 的服务端镜像）。
  const removeRow = async (id: string) => {
    try {
      await dispatch.transactions.deleteTransaction(id);
    } catch {
      // 服务端删除失败：本地行保持不动，错误已由 ErrorWidget 的 configuration error 通道提示。
      return;
    }

    try {
      const db = getDb();
      const scopeId = await getCurrentScope(db);
      await deleteLocalTransaction(db, scopeId, id);
    } catch (localError) {
      // 本地清理失败不阻断列表更新；错误走与表单一致的 reportError 通道。
      dispatch.configuration
        .reportError(localError instanceof Error ? localError : new Error(String(localError)))
        .catch(() => {});
    }

    setTransactions((prevState) => prevState.filter((item) => item.id !== id));
  };

  const deleteRow = (id: string) => {
    // deleteAlert 已拦截离线，这里兜底一次，避免其他入口绕过。
    guard(() => {
      removeRow(id);
    });
  };

  const goToDuplicate = (payload: { splits: TransactionSplitType[]; groupTitle: string; }) => navigation.dispatch(
    CommonActions.navigate({
      name: 'TransactionCreateScreen',
      params: {
        payload,
      },
    }),
  );

  const resetFilters = () => {
    setType('');
    setCurrentCode('');
    setSearch('');
    setAccount('');
    setCategoryId(undefined);
    setHasAnyCategory(undefined);
    setStartDate(startOfCurrentQuarter());
    searchInputRef.current = '';
    searchBarRef.current?.setText('');
  };

  const transactionSections = useMemo(
    () => {
      const byDay = new Map<string, TransactionType[]>();

      transactions.forEach((t) => {
        const date = t?.attributes?.transactions?.[0]?.date;
        const dayKey = date ? moment(date).format('YYYY-MM-DD') : 'Invalid date';

        const dayTransactions = byDay.get(dayKey);
        if (dayTransactions) {
          dayTransactions.push(t);
        } else {
          byDay.set(dayKey, [t]);
        }
      });

      return Array.from(byDay.entries()).map(([title, data]) => ({ title, data }));
    },
    [transactions],
  );

  return (
    <SwipeListView
      useSectionList
      nestedScrollEnabled={false}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={(
        <RefreshControl
          refreshing={false}
          onRefresh={manualRefresh}
        />
      )}
      ListHeaderComponent={(
        <>
          <SyncStatusBar />
          {error && (
            <AView
              style={{
                backgroundColor: colors.tileBackgroundColor,
                paddingHorizontal: 10,
                paddingVertical: 8,
              }}
            >
              <AText fontSize={12} color={colors.brandDanger}>
                {translate('transaction_load_failed')}
              </AText>
            </AView>
          )}
          <AStackFlex row backgroundColor={colors.tileBackgroundColor} py={5}>
            {(type !== '' || currentCode !== '' || account !== '') && (
              <AView
                style={{
                  justifyContent: 'center',
                  alignItems: 'center',
                  width: 30,
                  height: 30,
                  marginHorizontal: 5,
                }}
              >
                <Ionicons onPress={resetFilters} name="close-circle" size={24} color={colors.text} />
              </AView>
            )}
            <AScrollView horizontal showsHorizontalScrollIndicator={false}>
              <ADateFilterButton currentDate={startDate} selectDate={(date: Date) => setStartDate(date)} />
              <AFilterButton filterType={translate('transaction_type_label')} selected={type} selectFilter={(selected: 'withdrawal' | 'deposit' | 'transfer') => setType(selected)} navigation={navigation} capitalize />
              <AFilterButton filterType={translate('currency')} selected={currentCode} selectFilter={(selected) => setCurrentCode(selected)} navigation={navigation} />
              <AFilterButton filterType={translate('home_accounts')} selected={account} selectFilter={(selected) => setAccount(selected)} navigation={navigation} />
            </AScrollView>
          </AStackFlex>
        </>
      )}
      initialNumToRender={15}
      keyExtractor={(item: TransactionType) => item.id}
      sections={!loading ? transactionSections : []}
      showsVerticalScrollIndicator
      renderSectionHeader={({ section }) => {
        const label = moment(section.title, 'YYYY-MM-DD', true).isValid()
          ? moment(section.title, 'YYYY-MM-DD').format('LL')
          : section.title;
        return (
          <AView
            style={{
              backgroundColor: colors.tileBackgroundColor,
              paddingHorizontal: 10,
              paddingTop: 12,
              paddingBottom: 6,
              borderTopWidth: 0.5,
              borderColor: colors.listBorderColor,
            }}
          >
            <AText bold>{label}</AText>
          </AView>
        );
      }}
      renderItem={({ item }) => <RenderItem item={item} />}
      renderHiddenItem={(data, rowMap) => (
        <RenderHiddenItem
          handleOnPressCopy={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch();
            goToDuplicate({
              splits: resetTransactionsDates(data.item.attributes.transactions),
              groupTitle: data.item.attributes.groupTitle || '',
            });
          }}
          handleOnPressDelete={() => deleteAlert(data.item, rowMap, closeRow, deleteRow, guard)}
          online={online}
        />
      )}
      rightOpenValue={-90}
      stopRightSwipe={-190}
      rightActivationValue={-170}
      onRightActionStatusChange={({
        key,
        isActivated,
      }) => {
        if (!isActivated) {
          return null;
        }
        const transaction = transactions.find((t) => t.id === key);
        return transaction ? deleteAlert(transaction, [], closeRow, deleteRow, guard) : null;
      }}
      leftOpenValue={90}
      stopLeftSwipe={190}
      leftActivationValue={170}
      onLeftActionStatusChange={({
        key,
        isActivated,
      }) => {
        if (!isActivated) {
          return null;
        }
        const transaction = transactions.find((t) => t.id === key);
        return transaction ? goToDuplicate({
          splits: resetTransactionsDates(transaction.attributes.transactions),
          groupTitle: transaction.attributes.groupTitle || '',
        }) : null;
      }}
      contentContainerStyle={{ paddingBottom: 100 }}
      ListFooterComponent={(
        <ListFooterComponent
          onLoadMore={onLoadMore}
          loading={loading || loadingMore}
          hasMore={nextOffset !== null}
        />
      )}
    />
  );
}
