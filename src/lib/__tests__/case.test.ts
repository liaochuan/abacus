import { convertKeysToCamelCase } from '../case';

test('snake_case 键递归转 camelCase', () => {
  expect(convertKeysToCamelCase({
    group_title: 'G',
    nested_obj: { source_name: 'Cash', list: [{ updated_at: 't' }] },
  })).toEqual({
    groupTitle: 'G',
    nestedObj: { sourceName: 'Cash', list: [{ updatedAt: 't' }] },
  });
});

test('已是 camelCase 时幂等；非对象值原样返回', () => {
  const input = {
    groupTitle: 'G', amount: 3.5, tags: ['a'], empty: null,
  };
  expect(convertKeysToCamelCase(input)).toEqual(input);
  expect(convertKeysToCamelCase(null)).toBeNull();
  expect(convertKeysToCamelCase('x')).toBe('x');
  expect(convertKeysToCamelCase([1, 2])).toEqual([1, 2]);
});
