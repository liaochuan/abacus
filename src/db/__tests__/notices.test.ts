import {
  acknowledgeNotice, listOpenNotices,
} from '../notices';
import type { Db } from '../types';

// notices 读写：用假 Db 只验证 SQL 形态与行映射。
// 两条语句都必须带 scope 过滤（项目硬规则），读取要有界且按时间升序。

const SCOPE = 'scope-a';
const OTHER_SCOPE = 'scope-b';

type Query = { sql: string; params: unknown[] };

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

type FakeDb = Db & { queries: Query[] };

const createDb = (rows: unknown[] = []): FakeDb => {
  const queries: Query[] = [];

  const record = (sql: string, params: unknown[] = []) => {
    const normalized = normalize(sql);
    const marks = normalized.split('?').length - 1;
    if (marks !== params.length) {
      throw new Error(`placeholder/param mismatch (${marks} vs ${params.length}): ${normalized}`);
    }
    queries.push({ sql: normalized, params });
    return normalized;
  };

  return {
    queries,
    exec: async () => {},
    tx: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    get: async () => null,
    all: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      record(sql, params);
      return rows as T[];
    },
    run: async (sql: string, params: unknown[] = []) => {
      record(sql, params);
    },
  };
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  kind: 'conflict',
  entity_id: 'e1',
  local_payload: JSON.stringify({ attributes: { groupTitle: 'L', transactions: [] } }),
  server_payload: JSON.stringify({ attributes: { groupTitle: 'S', transactions: [] } }),
  detected_at: '2026-10-01T00:00:00.000Z',
  ...over,
});

test('listOpenNotices 只读未确认、按发现时间升序、有界且锁定 scope', async () => {
  const db = createDb([row()]);

  const notices = await listOpenNotices(db, SCOPE);

  expect(notices).toHaveLength(1);
  const query = db.queries[0];
  expect(query.sql).toMatch(/FROM notices/i);
  expect(query.sql).toMatch(/acknowledged_at IS NULL/i);
  expect(query.sql).toMatch(/ORDER BY detected_at ASC/i);
  expect(query.sql).toMatch(/LIMIT \?/i);
  expect(query.params[0]).toBe(SCOPE);
  expect(query.params).not.toContain(OTHER_SCOPE);
  expect(Number.isInteger(query.params[1])).toBe(true);
});

test('listOpenNotices 把行映射成 camelCase 并解析 payload', async () => {
  const db = createDb([
    row(),
    row({
      id: 'n2',
      kind: 'server_deletion',
      entity_id: 'e2',
      local_payload: null,
      server_payload: JSON.stringify({ attributes: { groupTitle: 'gone', transactions: [] } }),
    }),
    // 坏 JSON 不能让整批读取失败：local 退化为 null，server 退化为空快照。
    row({ id: 'n3', local_payload: '{not json', server_payload: 'also bad' }),
    // 未知 kind：没有对应展示方式，跳过。
    row({ id: 'n4', kind: 'mystery' }),
  ]);

  const notices = await listOpenNotices(db, SCOPE);

  expect(notices.map((notice) => notice.id)).toEqual(['n1', 'n2', 'n3']);
  expect(notices[0]).toMatchObject({
    kind: 'conflict',
    entityId: 'e1',
    detectedAt: '2026-10-01T00:00:00.000Z',
  });
  expect(notices[0].localPayload?.attributes.groupTitle).toBe('L');
  expect(notices[0].serverPayload.attributes.groupTitle).toBe('S');
  expect(notices[1].kind).toBe('server_deletion');
  expect(notices[1].localPayload).toBeNull();
  expect(notices[1].serverPayload.attributes.groupTitle).toBe('gone');
  expect(notices[2].localPayload).toBeNull();
  expect(notices[2].serverPayload.attributes.transactions).toEqual([]);
});

test('scope 为空时 listOpenNotices 不查库', async () => {
  const db = createDb([row()]);

  await expect(listOpenNotices(db, '')).resolves.toEqual([]);
  expect(db.queries).toHaveLength(0);
});

test('acknowledgeNotice 回填时间戳且带 scope 过滤', async () => {
  const db = createDb();

  await acknowledgeNotice(db, 'n1', SCOPE);

  expect(db.queries).toHaveLength(1);
  const query = db.queries[0];
  expect(query.sql).toMatch(/UPDATE notices SET acknowledged_at = \?/i);
  expect(query.sql).toMatch(/WHERE scope_id = \? AND id = \?/i);
  expect(query.params[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(query.params[1]).toBe(SCOPE);
  expect(query.params[2]).toBe('n1');
});

test('id 或 scope 为空时 acknowledgeNotice 不查库', async () => {
  const db = createDb();

  await acknowledgeNotice(db, '', SCOPE);
  await acknowledgeNotice(db, 'n1', '');

  expect(db.queries).toHaveLength(0);
});
