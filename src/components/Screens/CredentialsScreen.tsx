import React, { useCallback, useLayoutEffect, useState } from 'react';
import { useRoute, CommonActions, useFocusEffect } from '@react-navigation/native';
import { AntDesign, Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import { useDispatch, useSelector } from 'react-redux';
import axios from 'axios';
import { Alert, SafeAreaView } from 'react-native';
import {
  AView,
  AText,
  AScrollView,
  AStackFlex,
  AIconButton,
} from '../UI/ALibrary';

import translate from '../../i18n/locale';
import { useThemeColors } from '../../lib/common';
import {
  deleteCredential, deleteOldSecureStore, getCredentials, isTokenFresh,
} from '../../lib/oauth';
import { classifyAuthError } from '../../lib/authError';
import { isOnline } from '../../lib/network';
import { requestSyncIfDue } from '../../lib/syncScheduler';
import { getDb } from '../../db/instance';
import { deleteScope, hasLocalData } from '../../db/repository';
import { getCurrentScope, scopeIdFor, setCurrentScope } from '../../db/scope';
import { emitSyncChanged } from '../../db/syncState';
import type { Db } from '../../db/types';
import { TCredential } from '../../types/credential';
import { ScreenType } from '../../types/screen';
import { RootDispatch, RootState } from '../../store';
import AButton from '../UI/ALibrary/AButton';
import ErrorBoundary from '../UI/ErrorBoundary';

export default function CredentialsScreen({ navigation, route }: ScreenType) {
  const { colors } = useThemeColors();
  const selectedBrandStyle = useSelector((state: RootState) => state.configuration.selectedBrandStyle || colors.brandStyleOrange);
  const { name: routeName } = useRoute();
  const useBiometricAuth = useSelector((state: RootState) => state.configuration.useBiometricAuth);
  const [credentials, setCredentials] = useState<TCredential[]>([]);
  const [editMode, setEditMode] = useState<boolean>(false);
  const [authenticated, setAuthenticated] = useState<boolean>(false);
  const dispatch = useDispatch<RootDispatch>();

  const goToCredentialCreateScreen = (url: string) => navigation.dispatch(
    CommonActions.navigate({
      name: 'CredentialCreateScreen',
      params: {
        payload: {
          url,
        },
      },
    }),
  );

  const goToDashboard = () => navigation.dispatch(
    CommonActions.reset({ index: 0, routes: [{ name: 'dashboard' }] }),
  );

  // 登录/切换账号：所有分支都不删除凭证。scope 必须在任何网络请求之前切换，
  // 否则首页与交易列表仍会读上一个账号的本地数据。
  const loginWithCredential = async (credential: TCredential) => {
    const {
      backendURL: currentBackendURL,
      accessToken,
      accessTokenExpiresIn: expiresIn,
      refreshToken,
    } = credential;
    const scopeId = scopeIdFor(currentBackendURL, credential.email);

    let db: Db | null = null;
    try {
      db = getDb();
    } catch {
      // 数据库未初始化（degraded 启动）：跳过 scope 切换，照旧走在线登录。
      db = null;
    }

    // 写入 scope 后回读确认。返回 false 表示本地分区没有切到目标账号，
    // 此时不能进 dashboard，否则会出现「请求头是新账号、本地数据是旧账号」的混用。
    const activateScope = async (): Promise<boolean> => {
      if (!db) {
        return true;
      }
      try {
        await setCurrentScope(db, scopeId);
        // scope 变了，状态条要按新账号的 outbox / notices 重读一次（否则会继续显示上一个账号的计数）。
        emitSyncChanged();
        if ((await getCurrentScope(db)) === scopeId) {
          return true;
        }
        // eslint-disable-next-line no-console
        console.warn('[credentials] scope switch failed');
        return false;
      } catch {
        // eslint-disable-next-line no-console
        console.warn('[credentials] scope switch failed');
        return false;
      }
    };

    // 登录失败时回滚到上一个账号的请求头，避免 header 与 Redux/current_scope 不一致。
    const previousAuthorization = axios.defaults.headers.Authorization;

    // 成功确定后才改全局约定（backendURL / 币种 / 导航）；失败路径保持上一个账号的状态。
    const enterDashboard = () => {
      dispatch.configuration.setBackendURL(currentBackendURL);
      dispatch.currencies.setCurrentCode('');
      // 登录 / 切换账号后进入 dashboard：新 scope 的 last_synced_at 通常为空，会立即同步；
      // 冷启动若 SyncTriggers 刚同步过（不足 5 分钟），这里直接跳过，避免重复跑一轮。
      requestSyncIfDue('startup').catch(() => {});
      goToDashboard();
    };

    // 离线进入：必须有本地数据，scope 必须切换成功，且请求头要换成当前账号的 token，
    // 否则联网回来后会用上一个账号的 Authorization。
    const enterOffline = async (): Promise<boolean> => {
      if (!db) {
        return false;
      }
      let hasData = false;
      try {
        hasData = await hasLocalData(db, scopeId);
      } catch {
        // eslint-disable-next-line no-console
        console.warn('[credentials] offline data check failed');
        hasData = false;
      }
      if (!hasData) {
        return false;
      }
      if (!(await activateScope())) {
        return false;
      }
      axios.defaults.headers.Authorization = `Bearer ${accessToken}`;
      enterDashboard();
      return true;
    };

    if (!isOnline()) {
      // 离线：不尝试 refresh，有本地数据就直接进入 dashboard。
      if (await enterOffline()) {
        return;
      }
      Alert.alert(
        translate('oauth_token_error_title'),
        translate('oauth_token_error_description'),
      );
      return;
    }

    try {
      // refresh 只用 credential 的 backendURL/refreshToken，不依赖 current_scope 或 Redux；
      // 成功时它自己会把 header 换成新 token。失败则一个全局状态都还没动。
      const needsRefresh = !isTokenFresh(expiresIn) && Boolean(refreshToken);
      if (needsRefresh) {
        await dispatch.firefly.getFreshAccessToken(credential);
      }

      // scope 是最后一道闸门：写不进去就回滚 header，不导航、不保留 backendURL 变更。
      if (!(await activateScope())) {
        axios.defaults.headers.Authorization = previousAuthorization;
        Alert.alert(
          translate('oauth_token_error_title'),
          translate('oauth_token_error_description'),
        );
        return;
      }

      if (!needsRefresh) {
        axios.defaults.headers.Authorization = `Bearer ${accessToken}`;
      }

      enterDashboard();
    } catch (e: unknown) {
      // 登录失败绝不删除凭证：网络错误下本地数据仍然可用，认证失败也应保留账号让用户修 URL/密码，
      // 只有用户在凭证管理页主动确认删除时才清理（见 handleDeleteCredential）。
      if (classifyAuthError(e) === 'network' && await enterOffline()) {
        return;
      }

      axios.defaults.headers.Authorization = previousAuthorization;
      Alert.alert(translate('oauth_token_error_title'), e instanceof Error ? e.message : String(e));
    }
  };

  const bioAuthCheck = useCallback((c: TCredential[]) => {
    (async () => {
      if (useBiometricAuth && !authenticated) {
        const bioAuth = await LocalAuthentication.authenticateAsync({
          promptMessage: translate('authenticate_label'),
        });
        if (bioAuth.success !== true) {
          return;
        }
      }

      setAuthenticated(true);
      const {
        params: {
          noRedirect = false,
        } = {},
      } = route;
      if (c.length === 1 && routeName === 'credentials' && !noRedirect) {
        await loginWithCredential(c[0]);
      }
    })();
  }, [useBiometricAuth, authenticated]);

  useFocusEffect(
    useCallback(() => {
      // delete old secure store keys
      deleteOldSecureStore().catch();
      getCredentials()
        .then((c) => {
          setCredentials(c);
          return c;
        })
        .then((c) => bioAuthCheck(c));
    }, []),
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => credentials.length > 0 && (<AIconButton icon={<Ionicons name="settings-outline" color={selectedBrandStyle} size={24} />} onPress={() => setEditMode(!editMode)} />),
      headerRight: () => (<AIconButton icon={<Ionicons name="add-circle-outline" color={selectedBrandStyle} size={26} />} onPress={() => goToCredentialCreateScreen('')} />),
    });
  }, [navigation, credentials, goToCredentialCreateScreen, editMode, setEditMode]);

  const handleDeleteCredential = async (index: number) => {
    const credential = credentials[index];
    const deletedScope = credential ? scopeIdFor(credential.backendURL, credential.email) : '';
    await dispatch.configuration.resetAllStates();
    await deleteCredential(index);
    if (deletedScope) {
      try {
        // 用户主动删除账号时一并清掉该 scope 的本地数据，避免下一个账号复用残留内容。
        const db = getDb();
        await deleteScope(db, deletedScope);
        // 删的是当前账号时，current_scope 会变成指向空 scope 的悬空值，清除以便下次登录重新写入。
        if ((await getCurrentScope(db)) === deletedScope) {
          await setCurrentScope(db, '');
          // 当前账号被删且 scope 已清空：状态条回到空摘要，不再显示被删账号的积压。
          emitSyncChanged();
        }
      } catch {
        // 静态文案，不含令牌/账号/payload；删除失败不应卡住 UI。
        // eslint-disable-next-line no-console
        console.warn('[credentials] local scope cleanup failed');
      }
    }
    setCredentials((c) => c.filter((_, i) => i !== index));
    setEditMode(!editMode);
  };

  const showAlert = (index: number) => Alert.alert(
    translate('credential_clear_alert_title'),
    '',
    [
      {
        text: translate('credential_clear_confirm_button'),
        onPress: () => handleDeleteCredential(index),
        style: 'destructive',
      },
      {
        text: translate('credential_clear_cancel_button'),
        onPress: () => setEditMode(!editMode),
        style: 'cancel',
      },
    ],
  );

  if (!authenticated) {
    return (
      <AScrollView
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        bounces={false}
        showsVerticalScrollIndicator={false}
      >
        <AButton style={{ height: 50 }} mx={40} onPress={() => bioAuthCheck(credentials)}>
          <AStackFlex row>
            <Ionicons name="lock-open" size={15} color="white" style={{ margin: 5 }} />
            <AText fontSize={15}>{translate('auth_form_biometrics_lock')}</AText>
          </AStackFlex>
        </AButton>
      </AScrollView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ErrorBoundary>
        <AScrollView showsVerticalScrollIndicator={false}>
          {credentials.map((c, index) => (
            <AButton
              key={`${c.backendURL}-${c.email}-${index + 1}`}
              onPress={() => loginWithCredential(c)}
              disabled={editMode}
              style={{
                borderWidth: 0.5,
                borderColor: colors.listBorderColor,
                marginHorizontal: 7,
                marginBottom: 0,
                marginTop: 7,
              }}
            >
              <AView
                style={{
                  display: editMode ? 'flex' : 'none',
                  width: 17,
                  height: 17,
                  marginLeft: 15,
                  marginRight: 10,
                }}
              >
                <AView
                  style={{
                    flex: 1,
                    width: 16,
                    height: 16,
                    backgroundColor: 'white',
                    borderRadius: 10,
                    position: 'absolute',
                    top: 0.5,
                    left: 0.5,
                  }}
                />
                <AntDesign onPress={() => showAlert(index)} name="minus-circle" size={17} color="red" />
              </AView>
              <Ionicons style={{ marginHorizontal: 5 }} name="person-circle" size={27} color={colors.text} />
              <AStackFlex alignItems="flex-start" mx={5}>
                <AText py={2} numberOfLines={1} fontSize={16} bold>{c.email}</AText>
                <AText py={2} numberOfLines={1} fontSize={12} underline>{c.backendURL}</AText>
                <AText py={3} numberOfLines={1} fontSize={10}>
                  {c.accessTokenExpiresIn ? '(OAuth)' : '(Personal Access Token)'}
                </AText>
              </AStackFlex>
            </AButton>
          ))}
        </AScrollView>
      </ErrorBoundary>
    </SafeAreaView>
  );
}
