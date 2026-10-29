import React, {
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useState,
} from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  CommonActions,
  useFocusEffect,
  useScrollToTop,
  useNavigation,
} from '@react-navigation/native';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  RefreshControl,
  Animated,
  Switch,
  View, Pressable,
  TouchableOpacity,
} from 'react-native';
import type { PagerViewOnPageScrollEventData } from 'react-native-pager-view';
import PagerView from 'react-native-pager-view';

import { FontAwesome, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import moment from 'moment';
import { RootDispatch, RootState } from '../../store';
import translate from '../../i18n/locale';
import { localNumberFormat, useThemeColors } from '../../lib/common';
import { cachedCurrentCode } from '../../db/cachedCurrencies';
import { blobKeys } from '../../db/keys';
import { useBlob } from '../../db/useBlob';
import { isOnline } from '../../lib/network';
import { requestSync } from '../../lib/syncScheduler';
import type { AccountType } from '../../models/accounts';
import type { BillType } from '../../models/bills';
import type { BudgetType } from '../../models/budgets';
import type { CategoriesStateType } from '../../models/categories';
import type { HomeDisplayType } from '../../models/firefly';
import type { PiggyBank } from '../../models/piggyBanks';

import Pagination from '../UI/Pagination';
import SyncStatusBar from '../UI/SyncStatusBar';
import {
  AScrollView,
  AStack,
  AText,
  AView,
  AProgressBar,
  ASkeleton, AStackFlex,
} from '../UI/ALibrary';
import DisplayAllAccountsSwitch from '../UI/DisplayAllAccountsSwitch';
import IncomeExpenseBar from '../UI/IncomeExpenseBar';
import ErrorBoundary from '../UI/ErrorBoundary';

const EXTRA_SCROLL_PADDING = 120;

// 下拉刷新：先发起一轮后台同步（fire-and-forget，不阻塞刷新动画），
// 同时照旧刷新各视图的展示数据（在线时仍走 Redux 的接口调用）。
// 本函数不等同步结果：失败只改状态条，不打断下拉刷新。
const refreshWithSync = (tasks: Promise<unknown>[]) => {
  requestSync('manual').catch(() => {});
  return Promise.all(tasks);
};

type SummaryBlob = {
  netWorth: HomeDisplayType[];
  spent: HomeDisplayType[];
  earned: HomeDisplayType[];
  balance: HomeDisplayType[];
  bills: { paid: HomeDisplayType | null; unpaid: HomeDisplayType | null };
};

const AnimatedPagerView = Animated.createAnimatedComponent(PagerView);

function AssetsAccounts() {
  const { colors } = useThemeColors();
  const tabBarHeight = useBottomTabBarHeight();
  const start = useSelector((state: RootState) => state.firefly.rangeDetails.start);
  const end = useSelector((state: RootState) => state.firefly.rangeDetails.end);
  const currentCode = useSelector((state: RootState) => state.currencies.currentCode);
  const displayAllAccounts = useSelector((state: RootState) => state.configuration.displayAllAccounts);
  const { data: accountsData, error: accountsError } = useBlob<AccountType[]>(blobKeys.accounts(start, end, currentCode, displayAllAccounts));
  const accounts = accountsData ?? [];
  const loading = accountsData === null && isOnline() && !accountsError;
  const dispatch = useDispatch<RootDispatch>();
  const selectedBrandStyle = useSelector((state: RootState) => state.configuration.selectedBrandStyle || colors.brandStyleOrange);

  const [nameSortOrder, setNameSortOrder] = useState('asc');
  const [balanceSortOrder, setBalanceSortOrder] = useState('desc');
  const [lastPressed, setLastPressed] = useState(null);

  const handleSortPress = (position) => {
    setLastPressed(position);
    if (position === 'left') {
      setNameSortOrder(nameSortOrder === 'asc' ? 'desc' : 'asc');
      setBalanceSortOrder(null);
    } else if (position === 'right') {
      setBalanceSortOrder(balanceSortOrder === 'desc' ? 'asc' : 'desc');
      setNameSortOrder(null);
    }
  };

  const sortedAccounts = accounts
    .filter((a) => a.display || displayAllAccounts)
    .sort((a, b) => {
      if (nameSortOrder) {
        return nameSortOrder === 'asc'
          ? a.attributes.name.localeCompare(b.attributes.name)
          : b.attributes.name.localeCompare(a.attributes.name);
      } if (balanceSortOrder) {
        return balanceSortOrder === 'asc'
          ? parseFloat(a.attributes.currentBalance) - parseFloat(b.attributes.currentBalance)
          : parseFloat(b.attributes.currentBalance) - parseFloat(a.attributes.currentBalance);
      }
      return 0;
    });

  return (
    <AScrollView
      showsVerticalScrollIndicator={false}
      style={{ paddingBottom: tabBarHeight + EXTRA_SCROLL_PADDING }}
      refreshControl={(
        <RefreshControl
          refreshing={false}
          onRefresh={() => refreshWithSync([
            dispatch.accounts.getAccounts(),
            dispatch.firefly.getNetWorth(),
          ])}
        />
      )}
    >
      <AView>
        <AStack mx={15} my={10} row justifyContent="space-between" alignItems="center">
          <AText fontSize={25} bold>
            {displayAllAccounts ? translate('home_all_accounts') : translate('home_accounts')}
          </AText>
          <DisplayAllAccountsSwitch />
        </AStack>
        <AStack px={5} row justifyContent="space-between">
          <View style={{ flex: 1, alignItems: 'flex-start', paddingLeft: '5%' }}>
            <TouchableOpacity onPress={() => handleSortPress('left')}>
              <MaterialCommunityIcons
                name="sort"
                size={22}
                color={lastPressed === 'left' ? selectedBrandStyle : colors.text}
              />
            </TouchableOpacity>
          </View>
          <View style={{ flex: 1, alignItems: 'flex-end', paddingRight: '5%' }}>
            <TouchableOpacity onPress={() => handleSortPress('right')}>
              <MaterialCommunityIcons
                name="sort"
                size={22}
                color={lastPressed === 'right' ? selectedBrandStyle : colors.text}
                style={{ transform: [{ scaleX: -1 }] }}
              />
            </TouchableOpacity>
          </View>
        </AStack>
        {sortedAccounts.map((account, index) => {
          const balance = parseFloat(account.attributes.currentBalance);
          const balanceDifference = parseFloat(account.attributes.balanceDifference);
          const balanceDifferencePercent = balance && balanceDifference
            ? (Math.round((balanceDifference / Math.abs(balance)) * 10000) / 100)
            : 0;
          return (
            <AStackFlex
              key={account.id}
              row
              mx={20}
              style={{
                height: 45,
                maxWidth: '90%',
                borderColor: colors.listBorderColor,
                borderBottomWidth: index + 1 === accounts.length ? 0 : 0.5,
              }}
            >
              <AStackFlex
                row
                gap={10}
                justifyContent="flex-start"
                alignItems="center"
              >
                <AText
                  fontSize={14}
                  numberOfLines={1}
                >
                  {account.attributes.name}
                  <AText fontSize={10}>
                    {account.attributes.includeNetWorth ? '' : '*'}
                  </AText>
                </AText>

                {balanceDifferencePercent !== 0 && (
                  <ASkeleton loading={loading}>
                    <AText
                      fontSize={12}
                      numberOfLines={2}
                      textAlign="center"
                      px={3}
                      style={{
                        backgroundColor: balanceDifferencePercent < 0 && account.attributes.type !== 'liabilities' ? colors.red : colors.green,
                        borderRadius: 6,
                      }}
                      color="white"
                    >
                      {balanceDifferencePercent}
                      %
                    </AText>
                  </ASkeleton>
                )}
              </AStackFlex>
              <AStackFlex alignItems="flex-end" style={{ width: '100%' }}>
                <ASkeleton loading={loading}>
                  <AText
                    maxWidth={150}
                    fontSize={14}
                    numberOfLines={2}
                    textAlign="right"
                  >
                    {localNumberFormat(account.attributes.currencyCode, balance)}
                  </AText>
                  {balanceDifferencePercent !== 0 && (
                    <AText
                      maxWidth={150}
                      fontSize={12}
                      numberOfLines={2}
                      textAlign="right"
                      color={balanceDifferencePercent < 0 && account.attributes.type !== 'liabilities' ? colors.brandDanger : colors.brandSuccess}
                    >
                      {localNumberFormat(account.attributes.currencyCode, balanceDifference)}
                    </AText>
                  )}
                </ASkeleton>
              </AStackFlex>
            </AStackFlex>
          );
        })}
        <AText fontSize={9} py={10} px={15}>
          {translate('account_not_included_in_net_worth')}
        </AText>
      </AView>
    </AScrollView>
  );
}

function InsightCategories() {
  const { colors } = useThemeColors();
  const tabBarHeight = useBottomTabBarHeight();
  const startDate = useSelector((state: RootState) => state.firefly.rangeDetails.start);
  const end = useSelector((state: RootState) => state.firefly.rangeDetails.end);
  const currentCode = useSelector((state: RootState) => state.currencies.currentCode);
  const { data: categoriesData, error: categoriesError } = useBlob<CategoriesStateType>(blobKeys.categories(startDate, end, currentCode));
  const insightCategories = categoriesData?.insightCategories ?? [];
  const insightCategoriesTotal = categoriesData?.total;
  const insightCategoriesPerDay = categoriesData?.perDay;
  const loading = categoriesData === null && isOnline() && !categoriesError;
  const dispatch = useDispatch<RootDispatch>();
  const navigation = useNavigation();
  const expensesOnly = useSelector((state: RootState) => state.configuration.displayOnlyExpenseCategories);
  const selectedBrandStyle = useSelector((state: RootState) => state.configuration.selectedBrandStyle || colors.brandStyleOrange);

  const onSwitch = async (bool: boolean) => {
    dispatch.configuration.setDisplayOnlyExpenseCategories(bool);
    return Promise.resolve();
  };

  const goToTransactions = async (
    id: string,
    transactionParams: { categoryId?: string; hasAnyCategory?: boolean },
  ) => {
    navigation.dispatch(
      CommonActions.navigate(translate('navigation_transactions_tab'), {
        screen: 'TransactionsScreen',
        merge: true,
        params: {
          id,
          ...transactionParams,
          startDate: new Date(`${startDate}T12:00:00`),
        },
      }),
    );
  };

  return (
    <AScrollView
      showsVerticalScrollIndicator={false}
      style={{ paddingBottom: tabBarHeight + EXTRA_SCROLL_PADDING }}
      refreshControl={(
        <RefreshControl
          refreshing={false}
          onRefresh={() => refreshWithSync([
            dispatch.categories.getInsightCategories(),
            dispatch.firefly.getNetWorth(),
          ])}
        />
      )}
    >
      <AStack mx={15} my={10} row justifyContent="space-between" alignItems="center">
        <AText fontSize={25} bold>
          {expensesOnly ? translate('home_expense_categories') : translate('home_all_categories')}
        </AText>
        <Switch thumbColor="white" trackColor={{ false: '#767577', true: selectedBrandStyle }} onValueChange={onSwitch} value={expensesOnly} />
      </AStack>
      {[insightCategoriesPerDay, insightCategoriesTotal, ...insightCategories].map((category, index) => {
        if (!category || (expensesOnly && category.expense >= 0)) {
          return null;
        }

        return (
          <TouchableOpacity
            key={category.id}
            onPress={() => {
              if (category.name === 'total' || category.name === 'perday') return;
              if (category.name === 'no-category') {
                goToTransactions(category.id, { hasAnyCategory: false });
              } else {
                goToTransactions(category.id, { categoryId: category.id });
              }
            }}
          >
            <AView
              key={category.name}
              style={{
                borderColor: category.name === 'total' ? colors.dividerColor : colors.listBorderColor,
                borderBottomWidth: index - 1 === insightCategories.length ? 0 : 1,
                paddingBottom: !expensesOnly && category.name === 'total' ? 10 : 0,
              }}
            >
              <AStack
                row
                mx={15}
                style={{
                  height: 45,
                }}
                justifyContent="space-between"
              >
                <AText
                  fontSize={category.name === 'perday' ? 12 : 14}
                  maxWidth="60%"
                  numberOfLines={1}
                  bold={(category.name === 'total' || category.name === 'perday')}
                >
                  {(category.name === 'no-category') ? translate('no_category') : ''}
                  {(category.name === 'total') ? translate(expensesOnly ? 'category_total_spent' : 'category_total_balance') : ''}
                  {(category.name === 'perday') ? translate(expensesOnly ? 'category_perday_spent' : 'category_perday_balance') : ''}
                  {(category.name !== 'no-category' && category.name !== 'total' && category.name !== 'perday') ? category.name : null}
                </AText>

                <ASkeleton loading={loading}>
                  <AText
                    fontSize={category.name === 'perday' ? 12 : 14}
                    maxWidth={100}
                    numberOfLines={1}
                    bold={(category.name === 'total' || category.name === 'perday')}
                    color={!expensesOnly ? category.difference > 0 ? colors.brandSuccess : category.difference < 0 ? colors.brandDanger : colors.text : colors.text}
                  >
                    {localNumberFormat(
                      category.currencyCode,
                      expensesOnly ? category.expense * -1 : category.difference,
                    )}
                  </AText>
                </ASkeleton>
              </AStack>
              {!expensesOnly && category.name !== 'perday' && insightCategoriesTotal && (
                <IncomeExpenseBar
                  income={category.income}
                  incomeTotal={category.name === 'total' ? insightCategoriesTotal.income - insightCategoriesTotal.expense : insightCategoriesTotal.income}
                  expense={category.expense}
                  expenseTotal={category.name === 'total' ? insightCategoriesTotal.income - insightCategoriesTotal.expense : insightCategoriesTotal.expense}
                  currencyCode={category.currencyCode}
                  loading={loading}
                  barHeight={category.name === 'total' ? 10 : undefined}
                />
              )}
            </AView>
          </TouchableOpacity>
        );
      })}
    </AScrollView>
  );
}

function InsightBudgets() {
  const { colors } = useThemeColors();
  const tabBarHeight = useBottomTabBarHeight();
  const start = useSelector((state: RootState) => state.firefly.rangeDetails.start);
  const end = useSelector((state: RootState) => state.firefly.rangeDetails.end);
  const currentCode = useSelector((state: RootState) => state.currencies.currentCode);
  const { data: budgetsData, error: budgetsError } = useBlob<BudgetType[]>(blobKeys.budgets(start, end, currentCode));
  const insightBudgets = budgetsData ?? [];
  const loading = budgetsData === null && isOnline() && !budgetsError;
  const dispatch = useDispatch<RootDispatch>();

  return (
    <AScrollView
      showsVerticalScrollIndicator={false}
      style={{ paddingBottom: tabBarHeight + EXTRA_SCROLL_PADDING }}
      refreshControl={(
        <RefreshControl
          refreshing={false}
          onRefresh={() => refreshWithSync([
            dispatch.budgets.getInsightBudgets(),
            dispatch.firefly.getNetWorth(),
          ])}
        />
      )}
    >
      <AText fontSize={25} lineHeight={27} style={{ margin: 15 }} bold>
        {translate('home_budgets')}
      </AText>
      {insightBudgets.filter((budget) => budget.attributes?.active).map((budget) => (
        <AStack
          key={budget.attributes.name}
          mx={15}
          style={{ height: 60 }}
        >
          <AStackFlex row justifyContent="space-between">
            <AStack
              style={{ maxWidth: '80%' }}
              alignItems="flex-start"
            >
              <AText fontSize={14} lineHeight={22} numberOfLines={1}>
                {budget.attributes.name}
              </AText>
              <AText fontSize={12} lineHeight={20} numberOfLines={1}>
                {localNumberFormat(budget.currencyCode, budget.differenceFloat < 0 ? (budget.differenceFloat * -1) : budget.differenceFloat)}
                {' / '}
                {localNumberFormat(budget.currencyCode, budget.limit)}
              </AText>
            </AStack>

            <ASkeleton loading={loading}>
              <AStack alignItems="flex-end">
                <AStack
                  px={6}
                  py={2}
                  backgroundColor={-budget.differenceFloat > budget.limit ? colors.brandNeutralLight : colors.brandSuccessLight}
                  style={{ borderRadius: 5 }}
                >
                  <AText
                    fontSize={15}
                    numberOfLines={1}
                    color={-budget.differenceFloat > budget.limit ? colors.brandNeutral : colors.brandSuccess}
                    style={{ textAlign: 'center' }}
                    bold
                  >
                    {`${(budget.limit > 0 ? (((budget.differenceFloat * -1) * 100) / budget.limit).toFixed(0) : 0)}%`}
                  </AText>
                </AStack>
              </AStack>
            </ASkeleton>
          </AStackFlex>
          <AProgressBar
            color={-budget.differenceFloat > budget.limit ? colors.red : colors.green}
            value={((-budget.differenceFloat * 100) / budget.limit) || 0}
          />
        </AStack>
      ))}
    </AScrollView>
  );
}

function formatDate(date) {
  if (!date) {
    return translate('date_unavailable');
  }
  const momentDate = moment(date);
  const formattedDate = momentDate.isValid() ? momentDate.format('LL') : translate('date_unavailable');
  return formattedDate;
}

function Bills() {
  const { colors } = useThemeColors();
  const tabBarHeight = useBottomTabBarHeight();
  const { data: billsData, error: billsError } = useBlob<BillType[]>(blobKeys.bills());
  const bills = billsData ?? [];
  const loading = billsData === null && isOnline() && !billsError;
  const dispatch = useDispatch<RootDispatch>();

  return (
    <AScrollView
      showsVerticalScrollIndicator={false}
      style={{ paddingBottom: tabBarHeight + EXTRA_SCROLL_PADDING }}
      refreshControl={(
        <RefreshControl
          refreshing={loading}
          onRefresh={() => refreshWithSync([
            dispatch.bills.getBills(),
            dispatch.firefly.getNetWorth(),
          ])}
        />
      )}
    >
      <AText fontSize={25} lineHeight={27} style={{ margin: 15 }} bold>
        {translate('home_bills')}
      </AText>
      {bills.map((bill) => {
        const amountPaid = parseFloat(bill.attributes.currentPaidAmount || '0');
        const amountMin = parseFloat(bill.attributes.amountMin);
        const percentagePaid = (amountPaid / amountMin) * 100;
        const isPaid = amountPaid >= amountMin;

        const statusText = isPaid
          ? `${translate('bills_paid')} ${formatDate(bill.attributes.nextExpectedMatch)}`
          : amountPaid > 0
            ? `${percentagePaid.toFixed(0)}%`
            : `${translate('due_by')} ${formatDate(bill.attributes.nextExpectedMatch)}`;

        return (
          <AStack
            key={bill.id}
            mx={15}
            style={{
              height: 60,
            }}
          >
            <AStackFlex row justifyContent="space-between">
              <AStack
                style={{ maxWidth: '80%' }}
                alignItems="flex-start"
              >
                <AText fontSize={14} lineHeight={22} numberOfLines={1}>
                  {bill.attributes.name}
                </AText>
                <AText fontSize={12} lineHeight={20} numberOfLines={1}>
                  {localNumberFormat(bill.attributes.currencyCode, amountPaid)}
                  {' / '}
                  {localNumberFormat(bill.attributes.currencyCode, amountMin)}
                </AText>
              </AStack>

              <ASkeleton loading={loading}>
                <AStack alignItems="flex-end">
                  <AStack
                    px={6}
                    py={2}
                    backgroundColor={isPaid ? colors.brandSuccessLight : colors.brandNeutralLight}
                    style={{ borderRadius: 5 }}
                  >
                    <AText
                      fontSize={15}
                      numberOfLines={1}
                      color={isPaid ? colors.brandSuccess : colors.brandNeutral}
                      style={{ textAlign: 'center' }}
                      bold
                    >
                      {statusText}
                    </AText>
                  </AStack>
                </AStack>
              </ASkeleton>
            </AStackFlex>

            <AProgressBar
              color={percentagePaid >= 50.0 ? colors.green : colors.brandWarning}
              value={percentagePaid}
            />
          </AStack>
        );
      })}
    </AScrollView>
  );
}

function PiggyBanks() {
  const { colors } = useThemeColors();
  const tabBarHeight = useBottomTabBarHeight();
  const { data: piggyBanksData, error: piggyBanksError } = useBlob<PiggyBank[]>(blobKeys.piggyBanks());
  const piggyBanks = piggyBanksData ?? [];
  const loading = piggyBanksData === null && isOnline() && !piggyBanksError;
  const dispatch = useDispatch<RootDispatch>();

  return (
    <AScrollView
      showsVerticalScrollIndicator={false}
      style={{ paddingBottom: tabBarHeight + EXTRA_SCROLL_PADDING }}
      refreshControl={(
        <RefreshControl
          refreshing={false}
          onRefresh={() => refreshWithSync([
            dispatch.piggyBanks.getPiggyBanks(),
            dispatch.firefly.getNetWorth(),
          ])}
        />
      )}
    >
      <AText fontSize={25} lineHeight={27} style={{ margin: 15 }} bold>
        {translate('home_piggy_banks')}
      </AText>
      {piggyBanks.filter((pb) => pb.attributes?.percentage).map((pb) => (
        <AStack
          key={pb.id}
          mx={15}
          style={{
            height: 60,
          }}
        >
          <AStackFlex row justifyContent="space-between">
            <AStack
              style={{ maxWidth: '80%' }}
              alignItems="flex-start"
            >
              <AText fontSize={14} lineHeight={22} numberOfLines={1}>
                {pb.attributes.name}
              </AText>
              <AText fontSize={12} lineHeight={20} numberOfLines={1}>
                {localNumberFormat(pb.attributes.currencyCode, pb.attributes.currentAmount)}
                {' / '}
                {localNumberFormat(pb.attributes.currencyCode, pb.attributes.targetAmount)}
              </AText>
            </AStack>

            <ASkeleton loading={loading}>
              <AStack alignItems="flex-end">
                <AStack
                  px={6}
                  py={2}
                  backgroundColor={pb.attributes.leftToSave > 0.0 ? colors.brandNeutralLight : colors.brandSuccessLight}
                  style={{ borderRadius: 5 }}
                >
                  <AText
                    fontSize={15}
                    numberOfLines={1}
                    color={pb.attributes.leftToSave > 0.0 ? colors.brandNeutral : colors.brandSuccess}
                    style={{ textAlign: 'center' }}
                    bold
                  >
                    {`${pb.attributes.percentage?.toFixed(0)}%`}
                  </AText>
                </AStack>
              </AStack>
            </ASkeleton>
          </AStackFlex>

          <AProgressBar
            color={pb.attributes.percentage > 50.0 ? colors.green : colors.brandWarning}
            value={pb.attributes.percentage}
          />
        </AStack>
      ))}
    </AScrollView>
  );
}

function NetWorth() {
  const { colors } = useThemeColors();
  const hideBalance = useSelector((state: RootState) => state.configuration.hideBalance);
  const currentCode = useSelector((state: RootState) => state.currencies.currentCode);
  const start = useSelector((state: RootState) => state.firefly.rangeDetails.start);
  const end = useSelector((state: RootState) => state.firefly.rangeDetails.end);
  const dispatch = useDispatch<RootDispatch>();

  const { data: summary, stale, fetchedAt, error: summaryError } = useBlob<SummaryBlob>(blobKeys.summary(start, end, currentCode));
  const netWorth = summary?.netWorth ?? [];
  const balance = summary?.balance ?? [];
  const spent = summary?.spent ?? [];
  const earned = summary?.earned ?? [];
  const loading = summary === null && isOnline() && !summaryError;
  // 首次在线加载时 fetchedAt 仍为 null，此时不算「过期」，避免一进页面就提示。
  const showStaleMarker = (stale && fetchedAt !== null) || !isOnline();

  return useMemo(() => (
    <View testID="home_screen_net_worth">
      <Pressable onPress={() => dispatch.configuration.setHideBalance(!hideBalance)}>
        {!hideBalance && (
          <AView style={{
            height: 90,
            width: 300,
            justifyContent: 'center',
            alignItems: 'center',
          }}
          >
            <AText fontSize={12} lineHeight={18}>
              {`${translate('home_net_worth')} • ${currentCode}`}
            </AText>
            <ASkeleton loading={loading}>
              <AText
                fontSize={35}
                lineHeight={37}
                bold
                numberOfLines={1}
                maxWidth="90%"
                textAlign="center"
                adjustsFontSizeToFit
                minimumFontScale={0.6}
              >
                {localNumberFormat(currentCode, parseFloat(netWorth[0]?.monetaryValue || '0'))}
              </AText>
            </ASkeleton>

            {showStaleMarker && (
              <AText fontSize={10}>
                {translate('offline_data_stale')}
              </AText>
            )}

            {balance && balance[0] && earned && earned[0] && spent && spent[0] && !hideBalance && (
              <ASkeleton loading={loading}>
                <AStack
                  py={0}
                  my={1}
                  px={5}
                  backgroundColor={parseFloat(balance[0].monetaryValue) < 0 ? colors.brandNeutralLight : colors.brandSuccessLight}
                  style={{ borderRadius: 5 }}
                >
                  <AText
                    py={0}
                    bold
                    fontSize={12}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.7}
                    textAlign="center"
                    color={parseFloat(balance[0].monetaryValue) < 0 ? colors.brandNeutral : colors.brandSuccess}
                  >
                    {`${parseFloat(balance[0].monetaryValue) > 0 ? '+' : ''}${localNumberFormat(balance[0].currencyCode, parseFloat(balance[0].monetaryValue))}`}
                  </AText>
                </AStack>
              </ASkeleton>
            )}
          </AView>
        )}

        {hideBalance && (
          <AView style={{
            height: 90,
            width: 300,
            justifyContent: 'center',
            alignItems: 'center',
          }}
          >
            <FontAwesome
              name={hideBalance ? 'eye-slash' : 'eye'}
              size={30}
              color={colors.text}
            />
          </AView>
        )}
      </Pressable>
    </View>
  ), [
    loading,
    hideBalance,
    colors,
    netWorth,
    balance,
    earned,
    spent,
    currentCode,
    showStaleMarker,
  ]);
}

export default function HomeScreen() {
  const { colors, colorScheme } = useThemeColors();
  const safeAreaInsets = useSafeAreaInsets();
  const start = useSelector((state: RootState) => state.firefly.rangeDetails.start);
  const end = useSelector((state: RootState) => state.firefly.rangeDetails.end);
  const currentCode = useSelector((state: RootState) => state.currencies.currentCode);
  const dispatch = useDispatch<RootDispatch>();
  const selectedTheme = useSelector((state: RootState) => state.configuration.selectedTheme || 'gradientOrange');
  const lightSelectedColor = colors[`${selectedTheme}Light`] || colors.gradientOrangeLight;
  const darkSelectedColor = colors[`${selectedTheme}Dark`] || colors.gradientOrangeDark;
  const gradientColors = colorScheme === 'light' ? lightSelectedColor : darkSelectedColor;

  const renderIcons = [
    <Ionicons key="wallet" name="wallet" size={22} color={colors.text} />,
    <Ionicons key="pricetag" name="pricetags" size={22} color={colors.text} />,
    <MaterialCommunityIcons key="progress-check" name="progress-check" size={22} color={colors.text} />,
    <Ionicons key="calendar-clear" name="calendar-clear" size={22} color={colors.text} />,
    <MaterialCommunityIcons key="piggy-bank" name="piggy-bank" size={22} color={colors.text} />,
  ];

  useEffect(() => {
    (async () => {
      // 两个请求互不依赖：用 allSettled 消费，任一失败都不会变成未处理的 rejection。
      const [currencies] = await Promise.allSettled([
        dispatch.currencies.getCurrencies(),
        dispatch.configuration.getCurrentApiVersion(),
      ]);
      if (currencies.status === 'fulfilled') {
        return;
      }
      // 离线（或服务端不可达）时币种列表拉不到，currentCode 会一直是空串，
      // 新增交易表单随后因没有币种而中止。回落到 currencies blob 里的当前币种，
      // 只补 currentCode，币种列表等联网后的 getCurrencies 正常回填。
      const code = await cachedCurrentCode();
      if (code !== null) {
        dispatch.currencies.setCurrentCode(code);
      }
    })();
  }, []);

  const viewPagerRef = useRef<PagerView>(null);
  const scrollRef = useRef(null);

  useScrollToTop(scrollRef);

  useFocusEffect(
    useCallback(() => {
      // 进入首页触发一轮同步：区间/币种变化后重新进入也会补拉。
      // fire-and-forget：同步失败只影响状态条，页面继续显示本地缓存；
      // 并发与重复触发由 requestSync 的单飞锁吸收。
      requestSync('manual').catch(() => {});
    }, [start, end, currentCode]),
  );

  const scrollOffsetAnimatedValue = React.useRef(new Animated.Value(0)).current;
  const positionAnimatedValue = React.useRef(new Animated.Value(0)).current;

  return (useMemo(() => (
    <AView style={{ flex: 1 }}>
      <ErrorBoundary>
        <LinearGradient
          colors={gradientColors}
          start={{ x: 0, y: 1 }}
          end={{ x: 1, y: 0 }}
          style={{ minHeight: 250 + safeAreaInsets.top + 24 + 45, paddingTop: safeAreaInsets.top + 45 }}
        >
          <SyncStatusBar />
          <AStackFlex>
            <NetWorth />
            <Pagination
              renderIcons={renderIcons}
              handlePress={(index) => viewPagerRef?.current?.setPage(index)}
              scrollOffsetAnimatedValue={scrollOffsetAnimatedValue}
              positionAnimatedValue={positionAnimatedValue}
            />
          </AStackFlex>
        </LinearGradient>

        <View style={{ flex: 1 }}>
          <AView
            style={{
              backgroundColor: colors.tileBackgroundColor,
              borderTopLeftRadius: 30,
              borderTopRightRadius: 30,
              borderColor: colors.tileBackgroundColor,
              paddingTop: 5,
              position: 'absolute',
              top: -55,
              height: '150%',
              right: 0,
              left: 0,
            }}
          >
            <AnimatedPagerView
              ref={viewPagerRef}
              initialPage={0}
              style={{ flex: 1 }}
              onPageScroll={Animated.event<PagerViewOnPageScrollEventData>(
                [
                  {
                    nativeEvent: {
                      offset: scrollOffsetAnimatedValue,
                      position: positionAnimatedValue,
                    },
                  },
                ],
                {
                  useNativeDriver: true,
                },
              )}
            >
              <AssetsAccounts key="1" />
              <InsightCategories key="2" />
              <InsightBudgets key="3" />
              <Bills key="4" />
              <PiggyBanks key="5" />
            </AnimatedPagerView>
          </AView>
        </View>
      </ErrorBoundary>
    </AView>
  ), [colors]));
}
