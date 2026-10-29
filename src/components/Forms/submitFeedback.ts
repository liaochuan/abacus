// 提交结果的文案分支：离线只落了本地库、在线则视为已同步（推送由同步计划接线）。
// 返回的是语义标记而非 i18n key，便于调用方决定提示与后续动作。
export type SubmitFeedback = 'saved_pending' | 'saved_synced';

export function submitFeedback(online: boolean): SubmitFeedback {
  return online ? 'saved_synced' : 'saved_pending';
}
