import { useEffect, useState } from 'react';

import { getDb } from './instance';
import { readBlob } from './repository';
import { getCurrentScope } from './scope';
import { isStale } from './staleness';
import { subscribeSyncChanged } from './syncState';

// 从当前 scope 的 blobs 表读取一个键。mount、key 变化与同步事件后重读；
// 卸载/换键时丢弃过期结果；任何读取/解析异常都收敛为 data:null（不抛错）。
// stale 按渲染时刻的 fetchedAt 判定。
// error 表示最近一次读取抛错（DB 未初始化/损坏等），供消费方区分"加载中"与"读取失败"。
// 订阅同步事件是必需的：pull blobs 写完库只会 emitSyncChanged，不经过 React 状态，
// 不在这里重读的话界面会一直停在同步前的快照。
export function useBlob<T>(key: string | null): {
  data: T | null;
  fetchedAt: string | null;
  stale: boolean;
  error: boolean;
} {
  const [data, setData] = useState<T | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // 多次 load 可能乱序返回（同步事件与 key 变化叠加）：只让最后一次写入 state。
    let generation = 0;

    const load = async () => {
      generation += 1;
      const current = generation;
      if (key === null || key === '') {
        if (!cancelled && current === generation) {
          setData(null);
          setFetchedAt(null);
          setError(false);
        }
        return;
      }
      try {
        const db = getDb();
        const scopeId = await getCurrentScope(db);
        const blob = await readBlob<T>(db, scopeId, key);
        if (!cancelled && current === generation) {
          setData(blob?.payload ?? null);
          setFetchedAt(blob?.fetchedAt ?? null);
          setError(false);
        }
      } catch {
        if (!cancelled && current === generation) {
          setData(null);
          setFetchedAt(null);
          setError(true);
        }
      }
    };

    load();

    // 同步完成后 blob 可能已被重写：emitSyncChanged 只是信号，真正的新值还要再读一次。
    const unsubscribe = subscribeSyncChanged(() => {
      load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [key]);

  return { data, fetchedAt, stale: isStale(fetchedAt, new Date()), error };
}
