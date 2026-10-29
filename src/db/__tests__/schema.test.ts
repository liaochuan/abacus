import { SCHEMA_SQL, SCHEMA_VERSION } from '../schema';

test('schema 覆盖全部表与索引', () => {
  // 表清单来自 spec §7.3；for..of 仅为可读性，禁用 airbnb no-restricted-syntax。
  // eslint-disable-next-line no-restricted-syntax
  for (const t of ['meta', 'transactions', 'blobs', 'outbox', 'notices']) {
    expect(SCHEMA_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
  }
  expect(SCHEMA_SQL).toContain('idx_tx_scope_date');
  expect(SCHEMA_SQL).toContain('idx_outbox_status');
  expect(SCHEMA_SQL).toContain('idx_notices_pending');
  expect(SCHEMA_VERSION).toBe(1);
});
