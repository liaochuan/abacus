import React from 'react';
import {
  Alert, Platform, Switch,
} from 'react-native';
import * as Linking from 'expo-linking';
import * as Application from 'expo-application';
import * as LocalAuthentication from 'expo-local-authentication';
import {
  Octicons,
  FontAwesome,
  AntDesign,
  Ionicons,
} from '@expo/vector-icons';
import * as StoreReview from 'expo-store-review';
import { useDispatch, useSelector } from 'react-redux';
import { CommonActions } from '@react-navigation/native';

import translate from '../../i18n/locale';
import { useThemeColors } from '../../lib/common';
import { RootDispatch, RootState } from '../../store';
import { ScreenType } from '../../types/screen';
import { getDb } from '../../db/instance';
import { getCurrentScope, setCurrentScope } from '../../db/scope';
import { deleteScope } from '../../db/repository';
import { emitSyncChanged, isSyncRunning } from '../../db/syncState';
import { requestSync, startSyncTimer, stopSyncTimer } from '../../lib/syncScheduler';
import SyncIssueList from '../UI/SyncIssueList';
import {
  APressable,
  AScrollView,
  AStack,
  AText,
  AView,
} from '../UI/ALibrary';

export default function SettingsScreen({ navigation }: ScreenType) {
  const { colors } = useThemeColors();
  const closeTransactionScreen = useSelector((state: RootState) => state.configuration.closeTransactionScreen);
  const backendURL = useSelector((state: RootState) => state.configuration.backendURL);
  const useBiometricAuth = useSelector((state: RootState) => state.configuration.useBiometricAuth);
  const dispatch = useDispatch<RootDispatch>();
  const selectedBrandStyle = useSelector((state: RootState) => state.configuration.selectedBrandStyle || colors.brandStyleOrange);
  // 「查看待处理」复用状态条上的同一份列表，不另做一套界面。
  const [issuesOpen, setIssuesOpen] = React.useState(false);
  const {
    configuration: {
      setUseBiometricAuth,
      resetAllStates,
    },
  } = useDispatch<RootDispatch>();

  const bioAuthCallback = async (callback) => {
    const bioAuth = await LocalAuthentication.authenticateAsync({
      promptMessage: translate('authenticate_label'),
    });
    if (bioAuth.success) {
      callback();
    }
  };

  const reviewApp = async () => {
    if (await StoreReview.isAvailableAsync()) {
      await StoreReview.requestReview();
    }
  };

  const resetCache = async () => {
    await resetAllStates();
    navigation.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [
          { name: 'dashboard' },
        ],
      }),
    );
  };

  const showResetCacheAlert = () => Alert.alert(
    translate('configuration_clear_alert_title'),
    translate('configuration_clear_alert_text'),
    [
      {
        text: translate('configuration_clear_confirm_button'),
        onPress: () => resetCache(),
        style: 'destructive',
      },
      {
        text: translate('cancel'),
        style: 'cancel',
      },
    ],
  );

  const goToAccounts = () => navigation.dispatch(
    CommonActions.navigate({
      name: 'CredentialsScreen',
    }),
  );

  const goToCredentials = async () => {
    await resetAllStates();
    navigation.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [
          { name: 'credentials', params: { noRedirect: true } },
        ],
      }),
    );
  };

  const handleCheckBoxChange = async (bool: boolean) => {
    dispatch.configuration.setCloseTransactionScreen(bool);
    return Promise.resolve();
  };

  const showLogoutAlert = () => Alert.alert(
    translate('configuration_clear_alert_title'),
    '',
    [
      {
        text: 'OK',
        onPress: () => goToCredentials(),
        style: 'destructive',
      },
      {
        text: translate('cancel'),
        style: 'cancel',
      },
    ],
  );

  // 手动同步与状态条同一个入口：调度层负责在线判断、单飞与失败分类，
  // 这里 fire-and-forget，同步结果只反映在状态条上。
  const syncNow = () => {
    requestSync('manual').catch(() => {});
  };

  // 重新初始化本地数据：清空当前 scope 的交易/blob/队列/提示/元数据并清掉 current_scope，
  // 再回到登录页。凭证本身由登录页管理，这里只做「本地库 + 当前分区」的重置。
  const resetLocalData = async () => {
    // 先做最便宜、也最不该有副作用的检查：同步进行中就直接放弃，定时器保持原样。
    if (isSyncRunning()) {
      Alert.alert(translate('sync_settings_busy'));
      return;
    }

    // 已知限制：isSyncRunning() 与下面 deleteScope 之间仍有窗口，前台/网络触发可能在此刻
    // 启动新的 runSync 并写回旧 scope。这里不引入新锁（本任务只修定时器泄漏），只把
    // 定时器停掉，避免自续期在删除期间继续触发同步。
    stopSyncTimer();
    try {
      const db = getDb();
      const scopeId = await getCurrentScope(db);
      if (scopeId) {
        await deleteScope(db, scopeId);
        await setCurrentScope(db, '');
      }
      // 状态条与提示弹窗都依赖这条广播回到空摘要。
      emitSyncChanged();
    } catch {
      // 静态文案，不含令牌/账号/payload；失败时留在当前页，不能造成「已清空」的错觉。
      Alert.alert(translate('error_widget_title'));
      // 删除没成功，周期同步必须恢复，否则本次失败会永久关掉后台同步。
      startSyncTimer();
      return;
    }
    // 成功路径同样要恢复定时器：scope 已清空，排期会因没有账号而停表；
    // 重新登录后由进入 dashboard 的触发接管。
    startSyncTimer();
    await goToCredentials();
  };

  // 二次确认：第一次说明后果，第二次才是真正的破坏性操作。
  const showResetLocalDataAlert = () => Alert.alert(
    translate('sync_settings_reset'),
    translate('sync_settings_reset_warning'),
    [
      {
        text: translate('cancel'),
        style: 'cancel',
      },
      {
        text: translate('configuration_clear_confirm_button'),
        style: 'destructive',
        onPress: () => Alert.alert(
          translate('sync_settings_reset_confirm_title'),
          translate('sync_settings_reset_confirm_message'),
          [
            {
              text: translate('cancel'),
              style: 'cancel',
            },
            {
              text: translate('credential_clear_confirm_button'),
              style: 'destructive',
              onPress: () => {
                resetLocalData().catch(() => {});
              },
            },
          ],
        ),
      },
    ],
  );

  return (
    <AScrollView>
      <AText py={10} px={10} fontSize={18} bold>
        {translate('configuration_security')}
      </AText>
      <AView
        style={{
          borderTopWidth: 0.5,
          borderBottomWidth: 0.5,
          borderColor: colors.listBorderColor,
          backgroundColor: colors.tileBackgroundColor,
        }}
      >
        <AStack
          row
          justifyContent="space-between"
          style={{
            height: 45,
            paddingHorizontal: 10,
            paddingVertical: 5,
            marginLeft: 10,
            marginRight: 10,
            borderBottomWidth: 0.5,
            borderColor: colors.listBorderColor,
          }}
        >
          <AText fontSize={14}>URL</AText>
          <AText fontSize={14} onPress={() => Linking.openURL(backendURL)} underline>{backendURL}</AText>
        </AStack>
        <APressable
          flexDirection="row"
          onPress={goToAccounts}
          style={{
            justifyContent: 'space-between',
            height: 45,
            marginLeft: 10,
            marginRight: 10,
            borderBottomWidth: 0.5,
            borderColor: colors.listBorderColor,
          }}
        >
          <AText fontSize={14}>{translate('configuration_manage_credentials')}</AText>
          <FontAwesome name="angle-right" size={22} color="gray" />
        </APressable>
        <AStack
          row
          justifyContent="space-between"
          style={{
            height: 45,
            marginLeft: 10,
            marginRight: 10,
          }}
        >
          <AText fontSize={14}>{translate('auth_form_biometrics_lock')}</AText>
          <AView>
            <Switch thumbColor="white" trackColor={{ false: '#767577', true: selectedBrandStyle }} onValueChange={() => bioAuthCallback(setUseBiometricAuth)} value={useBiometricAuth} />
          </AView>
        </AStack>
      </AView>

      <AText py={10} px={10} fontSize={18} bold>
        {translate('sync_settings_title')}
      </AText>
      <AView
        style={{
          borderTopWidth: 0.5,
          borderBottomWidth: 0.5,
          borderColor: colors.listBorderColor,
          backgroundColor: colors.tileBackgroundColor,
        }}
      >
        <APressable
          testID="settings_sync_now"
          flexDirection="row"
          onPress={syncNow}
          style={{
            justifyContent: 'space-between',
            height: 45,
            paddingRight: 10,
            marginLeft: 10,
            borderBottomWidth: 0.5,
            borderColor: colors.listBorderColor,
          }}
        >
          <AText fontSize={14}>{translate('sync_settings_sync_now')}</AText>
          <AntDesign name="sync" size={18} color="gray" />
        </APressable>
        <APressable
          testID="settings_sync_issues"
          flexDirection="row"
          onPress={() => setIssuesOpen(true)}
          style={{
            justifyContent: 'space-between',
            height: 45,
            paddingRight: 10,
            marginLeft: 10,
            borderBottomWidth: 0.5,
            borderColor: colors.listBorderColor,
          }}
        >
          <AText fontSize={14}>{translate('sync_settings_issues')}</AText>
          <FontAwesome name="angle-right" size={22} color="gray" />
        </APressable>
        <APressable
          testID="settings_sync_reset"
          flexDirection="row"
          onPress={showResetLocalDataAlert}
          style={{
            justifyContent: 'space-between',
            height: 45,
            paddingRight: 10,
            marginLeft: 10,
          }}
        >
          <AText fontSize={14}>{translate('sync_settings_reset')}</AText>
          <FontAwesome name="angle-right" size={22} color="gray" />
        </APressable>
      </AView>

      <AText py={10} px={10} fontSize={18} bold>
        {translate('configuration_about')}
      </AText>
      <AView
        style={{
          borderTopWidth: 0.5,
          borderBottomWidth: 0.5,
          borderColor: colors.listBorderColor,
          backgroundColor: colors.tileBackgroundColor,
        }}
      >
        <AStack
          row
          justifyContent="space-between"
          style={{
            height: 45,
            marginLeft: 10,
            paddingRight: 10,
            borderBottomWidth: 0.5,
            borderColor: colors.listBorderColor,
          }}
        >
          <AText fontSize={14}>{translate('configuration_app_version')}</AText>
          <AText fontSize={14}>{Application.nativeApplicationVersion}</AText>
        </AStack>
        <APressable
          flexDirection="row"
          onPress={() => Linking.openURL('https://github.com/victorbalssa/abacus/discussions/')}
          style={{
            justifyContent: 'space-between',
            height: 45,
            paddingRight: 10,
            marginLeft: 10,
            borderBottomWidth: 0.5,
            borderColor: colors.listBorderColor,
          }}
        >
          <AText fontSize={14}>{translate('configuration_share_feedback')}</AText>
          <Octicons name="cross-reference" size={20} color="gray" />
        </APressable>
        <APressable
          flexDirection="row"
          onPress={() => Linking.openURL('https://github.com/victorbalssa/abacus/issues/new')}
          style={{
            justifyContent: 'space-between',
            height: 45,
            paddingRight: 10,
            marginLeft: 10,
            borderBottomWidth: 0.5,
            borderColor: colors.listBorderColor,
          }}
        >
          <AText fontSize={14}>{translate('configuration_report_issue')}</AText>
          <Octicons name="issue-opened" size={20} color="gray" />
        </APressable>
        <APressable
          flexDirection="row"
          onPress={() => Linking.openURL('https://github.com/victorbalssa/abacus')}
          style={{
            justifyContent: 'space-between',
            height: 45,
            paddingRight: 10,
            marginLeft: 10,
            borderBottomWidth: 0.5,
            borderColor: colors.listBorderColor,
          }}
        >
          <AText fontSize={14}>{translate('configuration_sources')}</AText>
          <AntDesign name="github" size={22} color="gray" />
        </APressable>
        <APressable
          flexDirection="row"
          onPress={reviewApp}
          style={{
            justifyContent: 'space-between',
            height: 45,
            paddingRight: 10,
            marginLeft: 10,
          }}
        >
          <AText fontSize={14}>{translate(Platform.select({ ios: 'configuration_review_app_ios', android: 'configuration_review_app_android' }))}</AText>
          <Ionicons name={Platform.select({ ios: 'logo-apple-appstore', android: 'logo-google-playstore' })} size={23} color="gray" />
        </APressable>
      </AView>
      <AText py={10} px={10} fontSize={18} bold>
        {translate('configuration_transaction_form')}
      </AText>
      <AView
        style={{
          borderTopWidth: 0.5,
          borderBottomWidth: 0.5,
          borderColor: colors.listBorderColor,
          backgroundColor: colors.tileBackgroundColor,
        }}
      >
        <AStack
          row
          justifyContent="space-between"
          style={{
            height: 45,
            paddingHorizontal: 10,
            paddingVertical: 5,
            marginLeft: 10,
          }}
        >
          <AText fontSize={14}>{translate('close_after_transaction')}</AText>
          <AView>
            <Switch thumbColor="white" trackColor={{ false: '#767577', true: selectedBrandStyle }} onValueChange={handleCheckBoxChange} value={closeTransactionScreen} />
          </AView>
        </AStack>
      </AView>

      <AText py={10} px={10} fontSize={18} bold>
        {translate('configuration_theme')}
      </AText>
      <AView
        style={{
          borderTopWidth: 0.5,
          borderBottomWidth: 0.5,
          borderColor: colors.listBorderColor,
          backgroundColor: colors.tileBackgroundColor,
        }}
      >
        <APressable
          flexDirection="row"
          onPress={() => navigation.navigate('SettingsColorSelectionScreen', { filterType: '', selectFilter: () => {} })}
          style={{
            justifyContent: 'space-between',
            height: 45,
            paddingHorizontal: 10,
            paddingVertical: 5,
            marginLeft: 10,
            borderBottomWidth: 0.5,
            borderColor: colors.listBorderColor,
          }}
        >
          <AText fontSize={14}>{translate('configuration_theme_selection')}</AText>
          <FontAwesome name="angle-right" size={22} color="gray" />
        </APressable>
      </AView>

      <AText py={10} px={10} fontSize={18} bold>
        {translate('configuration_debug')}
      </AText>
      <AView
        style={{
          borderTopWidth: 0.5,
          borderBottomWidth: 0.5,
          borderColor: colors.listBorderColor,
          backgroundColor: colors.tileBackgroundColor,
        }}
      >
        <APressable
          flexDirection="row"
          onPress={() => Linking.openURL('https://github.com/victorbalssa/abacus/blob/master/.github/HELP.md')}
          style={{
            justifyContent: 'space-between',
            height: 45,
            paddingHorizontal: 10,
            paddingVertical: 5,
            marginLeft: 10,
            borderBottomWidth: 0.5,
            borderColor: colors.listBorderColor,
          }}
        >
          <AText fontSize={14}>{translate('configuration_get_help')}</AText>
          <FontAwesome name="angle-right" size={22} color="gray" />
        </APressable>
        <APressable
          flexDirection="row"
          onPress={showResetCacheAlert}
          style={{
            justifyContent: 'space-between',
            height: 45,
            paddingHorizontal: 10,
            paddingVertical: 5,
            marginLeft: 10,
            borderBottomWidth: 0.5,
            borderColor: colors.listBorderColor,
          }}
        >
          <AText fontSize={14}>{translate('configuration_clear_option')}</AText>
          <FontAwesome name="angle-right" size={22} color="gray" />
        </APressable>
        <APressable
          flexDirection="row"
          onPress={showLogoutAlert}
          style={{
            justifyContent: 'space-between',
            height: 45,
            paddingHorizontal: 10,
            paddingVertical: 5,
            marginLeft: 10,
          }}
        >
          <AText fontSize={14}>{translate('go_to_credentials')}</AText>
          <FontAwesome name="angle-right" size={22} color="gray" />
        </APressable>
      </AView>

      {/* 列表 Modal 单独成层，不参与设置页的滚动布局（与状态条内挂载同一组件）。 */}
      <SyncIssueList visible={issuesOpen} onClose={() => setIssuesOpen(false)} />

      <AView style={{ height: 170 }} />
    </AScrollView>
  );
}
