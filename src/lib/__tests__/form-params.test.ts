import { toFormParams, isUsableRecord } from '../formParams';

test('详情页把服务端 id 与 base 传给表单', () => {
  const record = {
    id: '42', serverUpdatedAt: '2026-10-01T00:00:00Z', dirty: false, occurredAt: '2026-09-01',
    payload: { attributes: { groupTitle: 'G', transactions: [{ description: 'd' }] } },
  } as any;
  expect(toFormParams(record)).toEqual({
    id: '42', baseUpdatedAt: '2026-10-01T00:00:00Z', groupTitle: 'G', splits: [{ description: 'd' }],
  });
});

test('离线新建的交易没有服务端基线，baseUpdatedAt 为 null', () => {
  const record = {
    id: 'local:uuid', serverUpdatedAt: null, dirty: true, occurredAt: '2026-09-01',
    payload: { attributes: { groupTitle: 'G', transactions: [{ description: 'd' }] } },
  } as any;
  expect(toFormParams(record).baseUpdatedAt).toBeNull();
  expect(isUsableRecord(record)).toBe(true);
});

test('缺少 attributes 时返回空标题与空 splits，且判定为不可用', () => {
  const record = {
    id: '42', serverUpdatedAt: '2026-10-01T00:00:00Z', dirty: false, occurredAt: '2026-09-01',
    payload: {},
  } as any;
  expect(toFormParams(record)).toEqual({
    id: '42', baseUpdatedAt: '2026-10-01T00:00:00Z', groupTitle: '', splits: [],
  });
  expect(isUsableRecord(record)).toBe(false);
});

test('畸形 payload 不抛错：null、attributes 为 null、transactions 非数组都判为不可用', () => {
  const base = {
    id: '42', serverUpdatedAt: null, dirty: false, occurredAt: '2026-09-01',
  } as any;
  const malformed = [
    { ...base, payload: null },
    { ...base, payload: { attributes: null } },
    { ...base, payload: { attributes: { groupTitle: 'G', transactions: {} } } },
    { ...base, payload: { attributes: { groupTitle: 'G', transactions: [] } } },
  ];

  malformed.forEach((record) => {
    expect(isUsableRecord(record)).toBe(false);
    expect(() => toFormParams(record)).not.toThrow();
    expect(toFormParams(record).splits).toEqual([]);
  });
});
