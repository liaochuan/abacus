import React, {
  useEffect, FC, useMemo, useState, useRef, useCallback,
} from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { CommonActions, useFocusEffect, useScrollToTop } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RefreshControl } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import axios from 'axios';
import { TokenResponse } from 'expo-auth-session';
import * as LocalAuthentication from 'expo-local-authentication';
import {
  Box,
  HStack,
  Progress,
  ScrollView,
  Skeleton,
  Stack,
  Text,
  useToast,
  View,
  VStack,
} from 'native-base';

import { RootDispatch, RootState } from '../../store';
import secureKeys from '../../constants/oauth';
import ToastAlert from '../UI/ToastAlert';
import { ScreenType } from './types';
import { translate } from '../../i18n/locale';
import { localNumberFormat, useThemeColors } from '../../lib/common';
import Filters from '../UI/Filters';
import TabControl from '../UI/TabControl';

const InsightCategories: FC = () => {
  const { colors } = useThemeColors();
  const {
    categories: {
      getInsightCategories,
    },
  } = useDispatch<RootDispatch>();
  const insightCategories = useSelector((state: RootState) => state.categories.insightCategories);
  const { loading } = useSelector((state: RootState) => state.loading.effects.categories.getInsightCategories);

  return (
    <ScrollView
      refreshControl={(
        <RefreshControl
          refreshing={false}
          onRefresh={getInsightCategories}
          tintColor={colors.brandStyle}
        />
      )}
    >
      <Box mt={1} backgroundColor={colors.tileBackgroundColor} borderTopWidth={1} borderBottomWidth={1} borderColor={colors.listBorderColor}>
        {insightCategories.map((category, index) => (
          <HStack
            key={category.name}
            ml={5}
            pr={2}
            h={45}
            alignItems="center"
            justifyContent="space-between"
            borderBottomWidth={index + 1 === insightCategories.length ? 0 : 1}
            borderColor={colors.listBorderColor}
          >
            <Text>
              {category.name}
            </Text>

            {!loading ? (
              <Text>
                {localNumberFormat(category.currency_code, category.difference_float)}
              </Text>
            ) : (
              <Skeleton w={70} h={5} rounded={15} />
            )}
          </HStack>
        ))}
      </Box>
      <View style={{ height: 150 }} />
    </ScrollView>
  );
};

const InsightBudgets: FC = () => {
  const { colors } = useThemeColors();
  const {
    budgets: {
      getInsightBudgets,
    },
  } = useDispatch<RootDispatch>();
  const insightBudgets = useSelector((state: RootState) => state.budgets.insightBudgets);
  const { loading } = useSelector((state: RootState) => state.loading.effects.budgets.getInsightBudgets);

  return (
    <ScrollView
      refreshControl={(
        <RefreshControl
          refreshing={false}
          onRefresh={getInsightBudgets}
          tintColor={colors.brandStyle}
        />
      )}
    >
      <Box mt={1} backgroundColor={colors.tileBackgroundColor} borderTopWidth={1} borderBottomWidth={1} borderColor={colors.listBorderColor}>
        {insightBudgets.map((budget, index) => (
          <Stack
            key={budget.name}
          >
            <VStack
              ml={5}
              pr={2}
              h={60}
              justifyContent="center"
              borderBottomWidth={index + 1 === insightBudgets.length ? 0 : 1}
              borderColor={colors.listBorderColor}
            >
              <HStack
                pt={1}
                justifyContent="space-between"
                alignItems="center"
              >
                <Text>
                  {budget.name}
                </Text>

                {!loading ? (
                  <Text>
                    {localNumberFormat(budget.currency_code, budget.difference_float)}
                    /
                    {localNumberFormat(budget.currency_code, budget.limit)}
                  </Text>
                ) : (
                  <Skeleton w={140} h={5} rounded={15} />
                )}
              </HStack>
              <Progress
                colorScheme={-budget.difference_float > budget.limit ? 'danger' : 'success'}
                value={((-budget.difference_float * 100) / budget.limit) || 0}
                h={3}
                my={2}
              />
            </VStack>
          </Stack>
        ))}
      </Box>
      <View style={{ height: 150 }} />
    </ScrollView>
  );
};

const AssetsAccounts: FC = () => {
  const { colors } = useThemeColors();
  const {
    accounts: {
      getAccounts,
    },
  } = useDispatch<RootDispatch>();
  const accounts = useSelector((state: RootState) => state.accounts.accounts);
  const { loading } = useSelector((state: RootState) => state.loading.effects.accounts.getAccounts);

  return (
    <ScrollView
      refreshControl={(
        <RefreshControl
          refreshing={false}
          onRefresh={getAccounts}
          tintColor={colors.brandStyle}
        />
      )}
    >
      <Box backgroundColor={colors.tileBackgroundColor} mt={1} borderTopWidth={1} borderBottomWidth={1} borderColor={colors.listBorderColor}>
        {accounts && accounts?.filter((a) => a.attributes.active).map((account, index) => (
          <HStack
            key={account.attributes.name}
            ml={5}
            pr={2}
            h={45}
            alignItems="center"
            justifyContent="space-between"
            borderBottomWidth={index + 1 === accounts?.filter((a) => a.attributes.active).length ? 0 : 1}
            borderColor={colors.listBorderColor}
          >
            <Text>
              {account.attributes.name}
              {' '}
              <Text style={{ fontSize: 10 }}>
                {account.attributes.include_net_worth ? '' : '(*)'}
              </Text>
            </Text>

            {!loading ? (
              <Text>
                {localNumberFormat(account.attributes.currency_code, account.attributes.current_balance)}
              </Text>
            ) : (
              <Skeleton w={70} h={5} rounded={15} />
            )}
          </HStack>
        ))}
      </Box>
      <View style={{ height: 150 }} />
    </ScrollView>
  );
};

const NetWorth: FC = () => {
  const { colors } = useThemeColors();
  const netWorth = useSelector((state: RootState) => state.firefly.netWorth);
  const balance = useSelector((state: RootState) => state.firefly.balance);
  const loading = useSelector((state: RootState) => state.loading.effects.firefly.getNetWorth?.loading);

  return (
    <View>
      {netWorth && netWorth[0] && (
        <VStack pt={2} alignItems="center">

          {!loading ? (
            <Text
              testID="home_screen_net_worth_text"
              style={{
                fontSize: 27,
                lineHeight: 30,
                fontFamily: 'Montserrat_Bold',
              }}
            >
              {localNumberFormat(netWorth[0].currency_code, netWorth[0].monetary_value)}
            </Text>
          ) : (
            <Skeleton w={170} h={8} rounded={15} />
          )}
          <Text style={{
            fontSize: 13,
            fontFamily: 'Montserrat_Light',
            color: 'gray',
          }}
          >
            {`${translate('home_net_worth')} (${netWorth[0].currency_code})`}
          </Text>
        </VStack>
      )}

      {balance && balance[0] && (
        <VStack p={1} pb={2} justifyContent="center" alignItems="center">
          {!loading ? (
            <Box style={{
              backgroundColor: parseFloat(balance[0].monetary_value) < 0 ? colors.brandNeutralLight : colors.brandSuccessLight,
              borderRadius: 10,
              paddingHorizontal: 5,
            }}
            >
              <Text style={{
                fontSize: 13,
                fontFamily: 'Montserrat_Bold',
                textAlign: 'center',
                color: parseFloat(balance[0].monetary_value) < 0 ? colors.brandNeutral : colors.brandSuccess,
              }}
              >
                {`${parseFloat(balance[0].monetary_value) > 0 ? '+' : ''}${localNumberFormat(balance[0].currency_code, balance[0].monetary_value)}`}
              </Text>
            </Box>
          ) : (
            <Skeleton w={50} h={4} rounded={15} />
          )}
        </VStack>
      )}
    </View>
  );
};

const HomeScreen: FC = ({ navigation }: ScreenType) => {
  const { colors } = useThemeColors();
  const toast = useToast();
  const safeAreaInsets = useSafeAreaInsets();
  const { netWorth, balance } = useSelector((state: RootState) => state.firefly);
  const rangeDetails = useSelector((state: RootState) => state.firefly.rangeDetails);
  const currency = useSelector((state: RootState) => state.currencies.current);
  const { backendURL, faceId } = useSelector((state: RootState) => state.configuration);
  const { loading } = useSelector((state: RootState) => state.loading.models.firefly);
  const dispatch = useDispatch<RootDispatch>();
  const [tab, setTab] = useState('home_accounts');

  const goToOauth = () => navigation.dispatch(
    CommonActions.reset({
      index: 0,
      routes: [
        { name: 'oauth' },
      ],
    }),
  );

  const faceIdCheck = async () => {
    if (faceId) {
      const bioAuth = await LocalAuthentication.authenticateAsync();
      if (!bioAuth.success) {
        goToOauth();
      }
    }
  };

  useEffect(() => {
    (async () => {
      const tokens = await SecureStore.getItemAsync(secureKeys.tokens);
      const storageValue = JSON.parse(tokens);
      if (storageValue && storageValue.accessToken && backendURL) {
        axios.defaults.headers.Authorization = `Bearer ${storageValue.accessToken}`;

        try {
          if (!TokenResponse.isTokenFresh(storageValue)) {
            await dispatch.firefly.getFreshAccessToken(storageValue.refreshToken);
          }

          await faceIdCheck();
          await dispatch.currencies.getCurrencies();
        } catch (e) {
          toast.show({
            render: ({ id }) => (
              <ToastAlert
                onClose={() => toast.close(id)}
                title={translate('home_container_error_title')}
                status="error"
                variant="solid"
                description={`${translate('home_container_error_description')}, ${e.message}`}
              />
            ),
          });
        }
      } else {
        goToOauth();
      }
    })();
  }, []);

  const prevFiltersRef = useRef<string>();
  const scrollRef = React.useRef(null);

  useScrollToTop(scrollRef);

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      const fetchData = async () => {
        try {
          if (isActive && axios.defaults.headers.Authorization) {
            await Promise.all([
              dispatch.firefly.getNetWorth(),
              dispatch.accounts.getAccounts(),
              dispatch.categories.getInsightCategories(),
              dispatch.budgets.getInsightBudgets(),
            ]);
          }
        } catch (e) {
          // handle error
        }
      };

      if (prevFiltersRef.current !== `${rangeDetails?.start}-${rangeDetails?.end}-${currency?.id}`) {
        fetchData();
        prevFiltersRef.current = `${rangeDetails?.start}-${rangeDetails?.end}-${currency?.id}`;
      }

      return () => {
        isActive = false;
      };
    }, [rangeDetails, currency]),
  );

  return (useMemo(() => (
    <Box
      style={{
        flex: 1,
        paddingTop: safeAreaInsets.top + 55,
        backgroundColor: colors.backgroundColor,
      }}
    >
      <HStack justifyContent="space-between" mx={4} mt={4} py={2} px={4} backgroundColor={colors.tileBackgroundColor} borderRadius={10} borderWidth={1} borderColor={colors.listBorderColor}>
        <NetWorth />
        <Filters />
      </HStack>

      <TabControl
        values={['home_accounts', 'home_categories', 'home_budgets']}
        onChange={setTab}
      />

      {tab === 'home_accounts' && <AssetsAccounts />}
      {tab === 'home_categories' && <InsightCategories />}
      {tab === 'home_budgets' && <InsightBudgets />}
    </Box>
  ), [
    loading,
    netWorth,
    balance,
    tab,
  ]));
};

export default HomeScreen;