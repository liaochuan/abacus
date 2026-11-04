import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert, Keyboard, Platform, KeyboardAvoidingView, ScrollView, Switch, ActivityIndicator,
} from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import * as Haptics from 'expo-haptics';
import * as Crypto from 'expo-crypto';
import { Ionicons } from '@expo/vector-icons';

import TransactionSplitForm from '../Forms/TransactionSplitForm';
import { RootDispatch, RootState } from '../../store';
import translate from '../../i18n/locale';
import GroupTitle from './Fields/GroupTitle';
import { getDb } from '../../db/instance';
import { saveLocalTransaction } from '../../db/repository';
import { getCurrentScope } from '../../db/scope';
import { isOnline } from '../../lib/network';
import { requestAfterSave } from '../../lib/syncScheduler';

import Loading from '../UI/Loading';
import { initialSplit, TransactionType } from '../../models/transactions';
import { AStackFlex, AText, AView } from '../UI/ALibrary';
import AButton from '../UI/ALibrary/AButton';
import { useThemeColors } from '../../lib/common';

function MultipleTransactionSplitForm({ isNew, splits, title }) {
  const { colors } = useThemeColors();
  const displayForeignCurrency = useSelector((state: RootState) => state.configuration.displayForeignCurrency);
  const [splitNumber, setSplitNumber] = useState<string[]>([]);
  const dispatch = useDispatch<RootDispatch>();

  useEffect(() => {
    setSplitNumber(splits.length ? splits.map(() => Crypto.randomUUID()) : [Crypto.randomUUID()]);
  }, [splits]);

  const addTransactionSplit = () => {
    setSplitNumber((prevState) => [...prevState, Crypto.randomUUID()]);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch();
    dispatch.transactions.addTransactionSplit();
  };

  const deleteTransactionSplit = (index: number) => {
    setSplitNumber((prevState) => prevState.filter((_, i) => i !== index));
    dispatch.transactions.deleteTransactionSplit(index);
  };

  const onSwitch = async (bool: boolean) => {
    dispatch.configuration.setDisplayForeignCurrency(bool);
    return Promise.resolve();
  };

  if (splitNumber.length === 0) {
    return <Loading />;
  }

  return (
    <AView>
      {splitNumber.map((e, i) => (
        <TransactionSplitForm
          key={e}
          index={i}
          isNew={isNew}
          total={splitNumber.length}
          transaction={splits[i] || initialSplit()}
          handleDelete={() => deleteTransactionSplit(i)}
        />
      ))}
      <AButton
        style={{
          height: 40,
          marginTop: 5,
          borderWidth: 0.5,
          borderColor: colors.listBorderColor,
        }}
        onPress={addTransactionSplit}
      >
        <AStackFlex row>
          <Ionicons name="add-circle" size={22} color={colors.greyLight} style={{ margin: 5 }} />
          <AText color={colors.greyLight} fontSize={15}>{translate('transaction_form_new_split_button')}</AText>
        </AStackFlex>
      </AButton>
      <GroupTitle title={title || ''} />
      <AStackFlex row py={10} alignItems="center" justifyContent="space-between">
        <AText color={colors.greyLight} fontSize={14} bold>{translate('transaction_form_foreign_currency_label')}</AText>
        <Switch thumbColor="white" trackColor={{ false: '#767577', true: colors.brandStyle }} onValueChange={onSwitch} value={displayForeignCurrency} />
      </AStackFlex>
    </AView>
  );
}

function TransactionFormButtons({ handleSubmit }) {
  const loading = useSelector((state: RootState) => state.loading.effects.transactions.upsertTransaction?.loading);

  return (
    <AButton type="primary" loading={loading} style={{ height: 40, marginTop: 5 }} onPress={handleSubmit}>
      <AStackFlex row>
        <Ionicons name="cloud-upload-sharp" size={20} color="white" style={{ margin: 5 }} />
        <AText color="white" fontSize={15}>{translate('transaction_form_submit_button')}</AText>
      </AStackFlex>
    </AButton>
  );
}

export default function TransactionForm({
  navigation,
  title,
  splits = [],
  id = '-1',
  baseUpdatedAt = null,
}) {
  const { colors } = useThemeColors();
  const dispatch = useDispatch<RootDispatch>();
  const loading = useSelector((state: RootState) => state.loading.effects.transactions.upsertTransaction?.loading);
  const closeTransactionScreen = useSelector((state: RootState) => state.configuration.closeTransactionScreen);
  const transactionPayload = useSelector((state: RootState) => state.transactions.transactionPayload);
  const currentCode = useSelector((state: RootState) => state.currencies.currentCode);

  useEffect(() => {
    dispatch.transactions.resetTransaction({ splits, title });
  }, []);

  // 表单主体用 useMemo([]) 缓存，handleSubmit 的闭包会停留在首帧；
  // 因此提交时从 ref 读取最新表单状态，避免用到过期的交易内容或开关值。
  const submitState = useRef({
    transactionPayload, currentCode, id, closeTransactionScreen, baseUpdatedAt,
  });
  submitState.current = {
    transactionPayload, currentCode, id, closeTransactionScreen, baseUpdatedAt,
  };
  // 本地写入很快，但没有网络请求的 loading 态可依赖；用同步 ref 防止连点产生重复本地交易。
  const submittingRef = useRef(false);

  const handleSubmit = async () => {
    if (submittingRef.current) {
      return;
    }
    submittingRef.current = true;
    Keyboard.dismiss();
    const {
      transactionPayload: payload, currentCode: code, id: formId, closeTransactionScreen: shouldClose,
      baseUpdatedAt: base,
    } = submitState.current;
    const isCreate = !formId || formId === '-1';
    const online = isOnline();

    try {
      const db = getDb();
      const scopeId = await getCurrentScope(db);
      if (!scopeId) {
        throw new Error('no active account scope');
      }
      const splits = (payload?.transactions ?? []).map((split) => ({
        ...split,
        // 与旧的 UI→API 归一化保持一致：金额用点号小数，空串保持空串。
        amount: split.amount ? split.amount.replace(',', '.') : '',
        foreignAmount: split.foreignAmount ? split.foreignAmount.replace(',', '.') : '',
        // 未选分类时显式写空串，避免把旧分类 id 带进本地 payload。
        categoryId: split.categoryName === '' ? '' : split.categoryId,
        // 离线缓存的账户选项不带币种，空值用当前账户币种兜底；符号保持为空。
        currencyCode: split.currencyCode || code,
      }));
      // 当前币种也取不到时宁可中止，也不写入一条没有币种的交易。
      if (splits.some((split) => !split.currencyCode)) {
        Alert.alert(translate('error_widget_title'));
        return;
      }
      const transaction: TransactionType = {
        id: isCreate ? '' : formId,
        type: 'transactions',
        attributes: {
          groupTitle: payload?.title ?? '',
          transactions: splits,
          user: '',
          createdAt: '',
          updatedAt: '',
        },
      };

      await saveLocalTransaction(db, scopeId, {
        id: isCreate ? undefined : formId,
        payload: transaction,
        // 编辑基线由详情页从本地记录读出（serverUpdatedAt），新建时为 null。
        baseUpdatedAt: isCreate ? null : base ?? null,
      });

      // 保存结果不再弹窗：是否已推到服务端看顶栏的同步状态图标即可。
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch();
      if (online) {
        // 保存成功即尝试推送：离线时不触发（requestAfterSave 自己也会跳成 offline，
        // 但这里提前跳过可以避免保存后无意义的单飞锁占用）。
        // 先推 outbox 里待发的交易；pull 与图表刷新由调度层延后合并补跑，不阻塞上传。
        requestAfterSave().catch(() => {});
      }
      if (shouldClose) {
        navigation.goBack();
      }
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch();
      // 本地写入失败走 ErrorWidget 的统一错误提示（loading 插件记录 configuration 的错误）。
      dispatch.configuration.reportError(e instanceof Error ? e : new Error(String(e))).catch(() => {});
    } finally {
      submittingRef.current = false;
    }
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        loading ? <ActivityIndicator size="small" color={colors.text} /> : <AText onPress={handleSubmit} fontSize={16} bold>{translate('transaction_form_submit_button')}</AText>
      ),
    });
  }, [navigation, dispatch, title, splits, id, baseUpdatedAt, loading]);

  return useMemo(
    () => (
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
      >
        <ScrollView
          style={{
            padding: 10,
          }}
          keyboardShouldPersistTaps="handled"
          bounces={false}
        >
          <MultipleTransactionSplitForm isNew={id === '-1'} title={title} splits={splits} />
          <TransactionFormButtons handleSubmit={handleSubmit} />
          <AView style={{ height: 170 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    ),
    [],
  );
}
