import React, { useEffect, useState } from 'react';

import { ScreenType } from '../../types/screen';
import TransactionForm from '../Forms/TransactionForm';
import Loading from '../UI/Loading';
import ErrorWidget from '../UI/ErrorWidget';
import { getDb } from '../../db/instance';
import { getTransaction } from '../../db/repository';
import { getCurrentScope } from '../../db/scope';
import { subscribeSyncChanged } from '../../db/syncState';
import { toFormParams, isUsableRecord, TransactionFormParams } from '../../lib/formParams';

export default function TransactionDetailScreen({ navigation, route }: ScreenType) {
  const {
    params: {
      id,
      payload: {
        groupTitle,
        splits,
      } = {},
    } = {},
  } = route;

  // 本地记录是编辑的唯一数据源；读取完成前不渲染表单，避免用导航参数抢先提交。
  const [formParams, setFormParams] = useState<TransactionFormParams | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      let loaded: TransactionFormParams | null = null;
      try {
        const db = getDb();
        const scopeId = await getCurrentScope(db);
        const record = scopeId ? await getTransaction(db, scopeId, id) : null;
        // 畸形或空 payload 的记录不能进表单：否则空表单提交会把原交易清空。
        loaded = isUsableRecord(record) ? toFormParams(record) : null;
      } catch {
        // 本地读取失败按记录缺失处理，退回导航参数，不让详情页崩掉。
        loaded = null;
      }
      if (cancelled) {
        return;
      }
      if (loaded) {
        setFormParams(loaded);
        return;
      }
      // 首次加载缺记录时沿用导航参数（基线未知，按 null 处理）；
      // 同步后的重读失败则保留当前表单入参，不拿更旧的导航参数覆盖它。
      if (reloadToken === 0) {
        setFormParams({
          id, baseUpdatedAt: null, groupTitle, splits,
        });
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [id, groupTitle, splits, reloadToken]);

  // 同步会把服务端版本写回本地（可能换 id、刷新 serverUpdatedAt）：
  // 不重读就会让下次保存拿着过期基线提交，甚至对着已经失效的 id 发 update。
  // 重读只替换传给表单的 props，表单内部的输入态由 TransactionForm 自己持有，不会被覆盖。
  useEffect(() => subscribeSyncChanged(() => {
    setReloadToken((token) => token + 1);
  }), []);

  if (!formParams) {
    return <Loading />;
  }

  return (
    <>
      <TransactionForm
        navigation={navigation}
        splits={formParams.splits}
        title={formParams.groupTitle}
        id={formParams.id}
        baseUpdatedAt={formParams.baseUpdatedAt}
      />
      <ErrorWidget />
    </>
  );
}
