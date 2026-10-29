import React, { useEffect, useState } from 'react';

import { openDatabase, migrate } from './db';
import { setDb } from './instance';
import { getCurrentScope, scopeIdFor, setCurrentScope } from './scope';
import { migrateLegacyState } from './legacyMigration';
import { bootPhase } from './bootState';
import { getCredentials } from '../lib/oauth';
import SyncTriggers from '../lib/syncTriggers';
import type { TCredential } from '../types/credential';
import Loading from '../components/UI/Loading';

// isDefault 尚未进入 TCredential 类型，这里按控制器契约（credential 含可选 isDefault）以可选字段读取。
type Credential = TCredential & { isDefault?: boolean };

export default function AppBootstrap({ children }: { children: React.ReactNode }) {
  const [dbReady, setDbReady] = useState(false);
  const [credentialReady, setCredentialReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const db = await openDatabase();
        await migrate(db);
        setDb(db);
        if (!cancelled) {
          setDbReady(true);
        }

        // current_scope 是用户在账号列表里选定的账号，属于跨重启的持久状态：
        // 启动时已存在就原样保留，绝不能用 isDefault / 第一条凭据覆盖，否则每次冷启动
        // 都会把多账号用户悄悄切回第一个账号（且 syncContext 会严格按它匹配凭据）。
        // 只有从未选定过（空串）时才挑一个默认凭据并写入。
        const credentials = (await getCredentials()) as Credential[];
        let scopeId = await getCurrentScope(db);
        // 当前 scope 对应的凭据：迁移 persist:root 前要用它的 backendURL 核对旧数据归属。
        // 规则与 syncContext.pickCredential 一致：优先精确匹配 scope，仅单一凭据时容忍旧 scope 键。
        let credential = credentials.find((c) => scopeIdFor(c.backendURL, c.email) === scopeId)
          ?? (credentials.length === 1 ? credentials[0] : null);
        if (!scopeId) {
          credential = credentials.find((c) => c.isDefault) ?? credentials[0] ?? null;
          if (credential) {
            scopeId = scopeIdFor(credential.backendURL, credential.email);
            await setCurrentScope(db, scopeId);
          }
        }
        // 旧数据迁移只针对「实际当前」的那个 scope，不能迁移到用户没在用的分区里。
        // persist:root 全局且无账号维度，必须带上当前账号的 backendURL 才能核对归属。
        if (scopeId) {
          await migrateLegacyState(db, scopeId, credential?.backendURL ?? '');
        }
        if (!cancelled) {
          setCredentialReady(true);
        }
      } catch {
        // 初始化出错（含凭据读取失败）→ 记一条无内容日志（不含错误对象/凭据/路径），
        // 置 failed 并放行 children（degraded），既不报告 ready，也不困住用户。
        // eslint-disable-next-line no-console
        console.warn('[bootstrap] init failed');
        if (!cancelled) {
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const phase = bootPhase({ dbReady, credentialReady, failed });

  if (phase === 'loading') {
    return <Loading />;
  }

  // 只在 ready 时挂载触发点。degraded 表示数据库/凭据初始化失败，
  // 此时 getDb() 会抛错、也没有可靠的账号分区，启动同步没有意义；
  // 挂载只会在 degraded 状态里制造无效的 syncing/error 切换。
  // 降级仍放行 children，用户可继续使用已有界面，待恢复/重新登录后由手动触发同步。
  return (
    <>
      {phase === 'ready' ? <SyncTriggers /> : null}
      {children}
    </>
  );
}
