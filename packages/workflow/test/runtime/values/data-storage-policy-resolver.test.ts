import { describe, expect, it } from 'vitest';
import { type DataType } from '@dramaflow/contracts';
import {
  DefaultDataStoragePolicyResolver,
  DataStoragePolicyResolutionError,
} from '../../../src/index.js';

describe('统一自动存储策略', () => {
  it.each(['string', 'number', 'boolean', 'null'] as const)(
    'primitive %s 始终 inline，不按值大小猜测',
    (name) => {
      const resolver = new DefaultDataStoragePolicyResolver();
      expect(resolver.resolve({ kind: 'primitive', name }, '长'.repeat(20000))).toBe('inline');
    },
  );

  it.each(['system.json'])('%s 的显式规则为 inline', (name) =>
    expect(new DefaultDataStoragePolicyResolver().resolve({ kind: 'named', name }, {})).toBe(
      'inline',
    ),
  );

  it.each(['media.file', 'media.image', 'media.video', 'media.audio', 'media.document'])(
    '%s 即使业务描述很小也 reference',
    (name) =>
      expect(new DefaultDataStoragePolicyResolver().resolve({ kind: 'named', name }, {})).toBe(
        'reference',
      ),
  );

  it.each<DataType>([
    { kind: 'named', name: 'example.unregistered' },
    { kind: 'any' },
    { kind: 'array', itemType: { kind: 'named', name: 'media.image' } },
    { kind: 'object', properties: { image: { kind: 'named', name: 'media.image' } } },
    {
      kind: 'union',
      types: [
        { kind: 'primitive', name: 'string' },
        { kind: 'primitive', name: 'null' },
      ],
    },
  ])('无规则的类型失败，不把嵌套媒体静默 inline：$kind', (type) => {
    const resolver = new DefaultDataStoragePolicyResolver();
    expect(() => resolver.resolve(type, {})).toThrow(DataStoragePolicyResolutionError);
    try {
      resolver.resolve(type, {});
    } catch (error) {
      expect(error).toMatchObject({ code: 'DATA_STORAGE_POLICY_NOT_FOUND', type });
    }
  });

  it('可集中注入其他命名规则，复制规则表以免运行中被外部修改', () => {
    const rules = new Map([['example.document', 'reference' as const]]);
    const resolver = new DefaultDataStoragePolicyResolver(rules);
    rules.clear();
    expect(resolver.resolve({ kind: 'named', name: 'example.document' }, '小说')).toBe('reference');
    expect(resolver.resolve({ kind: 'named', name: 'media.video' }, {})).toBe('reference');
  });
});
