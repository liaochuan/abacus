import { submitFeedback } from '../../Forms/submitFeedback';

test('离线保存与在线保存文案不同', () => {
  expect(submitFeedback(false)).toBe('saved_pending');
  expect(submitFeedback(true)).toBe('saved_synced');
});
