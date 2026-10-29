// 启动阶段判定：只取决于数据库与凭证是否就绪，不等待大快照（blob/交易等）。
// dbReady 表示数据库已打开、迁移完成并 setDb；credentialReady 表示凭据已解析
// （无凭据也算就绪，进入凭据创建流程）。failed 为 true 表示初始化出错，
// 此时不报告 ready，而是 degraded（仍放行渲染，不困住用户）。

export type BootPhase = 'loading' | 'ready' | 'degraded';

export type BootState = {
  dbReady: boolean;
  credentialReady: boolean;
  failed?: boolean;
};

export function bootPhase({ dbReady, credentialReady, failed = false }: BootState): BootPhase {
  if (failed) {
    return 'degraded';
  }
  return dbReady && credentialReady ? 'ready' : 'loading';
}
