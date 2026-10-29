import React, { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import { AxiosError } from 'axios';

import { CommonActions, useNavigation } from '@react-navigation/native';
import { RootState } from '../../store';
import ToastMessage from './ToastMessage';
import translate from '../../i18n/locale';
import useToasts from './useToasts';

type ErrorPayload = { message?: string };

// 本地写入抛的是普通 Error（没有 response），不能直接读 response.data.message。
// 优先用服务端返回的错误文案，其次用 Error.message，最后退到通用标题。
const errorMessageOf = (error: unknown): string => {
  const axiosError = error as AxiosError<ErrorPayload> | undefined;
  const responseMessage = axiosError?.response?.data?.message;
  if (typeof responseMessage === 'string' && responseMessage !== '') {
    return responseMessage;
  }
  const message = (error as { message?: unknown } | undefined)?.message;
  if (typeof message === 'string' && message !== '') {
    return message;
  }
  return translate('error_widget_title');
};

export default function ErrorWidget() {
  const { showToast, toasts, removeToast } = useToasts();
  const error = useSelector((state: RootState) => state.loading.models.configuration.error);
  const success = useSelector((state: RootState) => state.loading.effects.transactions.upsertTransaction?.success);
  const navigation = useNavigation();

  const goToCredentials = async () => {
    navigation.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [
          { name: 'credentials', params: { noRedirect: true } },
        ],
      }),
    );
  };

  const isFirstRun = useRef(true);
  useEffect(() => {
    (async () => {
      if (error && !isFirstRun.current) {
        showToast(translate('error_widget_title'), errorMessageOf(error), 'error');
      }

      if (success && !isFirstRun.current) {
        showToast(translate('transaction_form_success_title'), translate('transaction_form_success_description'), 'success');
      }

      if (error && (error as AxiosError).response?.status && [401, 403].includes((error as AxiosError).response?.status) && !isFirstRun.current) {
        goToCredentials();
      }

      if (isFirstRun.current) {
        isFirstRun.current = false;
      }
    })();
  }, [error, success]);

  return toasts.map((toast) => (
    <ToastMessage
      key={toast.id}
      id={toast.id}
      type={toast.type}
      title={toast.title}
      description={toast.description}
      onUnmount={removeToast}
    />
  ));
}
