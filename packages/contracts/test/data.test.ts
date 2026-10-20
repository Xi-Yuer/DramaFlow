import { describe, expect, it } from 'vitest';
import {
  AnyType,
  StringType,
  NumberType,
  NullType,
  ImageType,
  VideoType,
  isTypeAssignable,
  dataTypeSchema,
  runtimeValueSchema,
  assetReferenceSchema,
  artifactSchema,
  assetSchema,
  nodeTypeManifestSchema,
} from '../src/index.js';
import type { DataType } from '../src/index.js';
const union = (...types: DataType[]): DataType => ({ kind: 'union', types });
const object = (properties: Record<string, DataType>): DataType => ({ kind: 'object', properties });

describe('共享 DataType 兼容规则', () => {
  it('primitive/named 精确匹配，数组不自动升降维，any 仅放宽目标', () => {
    expect(isTypeAssignable(StringType, StringType)).toBe(true);
    expect(isTypeAssignable(ImageType, VideoType)).toBe(false);
    expect(isTypeAssignable(ImageType, AnyType)).toBe(true);
    expect(isTypeAssignable(AnyType, ImageType)).toBe(false);
    expect(isTypeAssignable(StringType, { kind: 'array', itemType: StringType })).toBe(false);
    expect(isTypeAssignable({ kind: 'array', itemType: StringType }, StringType)).toBe(false);
    expect(
      isTypeAssignable(
        { kind: 'array', itemType: ImageType },
        { kind: 'array', itemType: AnyType },
      ),
    ).toBe(true);
  });
  it('union 比较全部来源可能性，nullable 由 null 分支表达', () => {
    expect(isTypeAssignable(StringType, union(StringType, NullType))).toBe(true);
    expect(isTypeAssignable(union(StringType, NullType), StringType)).toBe(false);
    expect(
      isTypeAssignable(union(StringType, NumberType), union(NullType, NumberType, StringType)),
    ).toBe(true);
    expect(isTypeAssignable(union(StringType, AnyType), union(StringType, NumberType))).toBe(false);
    expect(isTypeAssignable(NullType, union(StringType, NullType))).toBe(true);
  });
  it('对象按所需字段递归结构兼容，不混淆缺字段和可为 null', () => {
    expect(
      isTypeAssignable(
        object({ title: StringType, duration: NumberType }),
        object({ title: StringType }),
      ),
    ).toBe(true);
    expect(
      isTypeAssignable(
        object({ title: StringType }),
        object({ title: StringType, duration: NumberType }),
      ),
    ).toBe(false);
    expect(isTypeAssignable(object({}), object({ title: union(StringType, NullType) }))).toBe(
      false,
    );
    expect(isTypeAssignable(object({ title: NumberType }), object({ title: StringType }))).toBe(
      false,
    );
    expect(() =>
      dataTypeSchema.parse({
        kind: 'object',
        properties: JSON.parse('{"__proto__":{"kind":"any"}}'),
      }),
    ).toThrow();
    for (const value of [
      { kind: 'image' },
      { kind: 'array', item: { kind: 'any' } },
      { kind: 'named', name: 'Image' },
      { kind: 'union', types: [] },
    ])
      expect(dataTypeSchema.safeParse(value).success).toBe(false);
  });
});

describe('运行值、引用与持久内容协议', () => {
  it('值只区分承载方式，拒绝 Buffer 等非 JSON，资产版本必须明确', () => {
    expect(
      runtimeValueSchema.parse({ storage: 'inline', type: StringType, value: '短文本' }),
    ).toHaveProperty('value', '短文本');
    expect(
      runtimeValueSchema.parse({
        storage: 'reference',
        type: ImageType,
        reference: { kind: 'artifact', id: 'art-1' },
      }),
    ).toHaveProperty('reference.kind', 'artifact');
    expect(() => assetReferenceSchema.parse({ kind: 'asset', id: 'a1' })).toThrow();
    expect(assetReferenceSchema.parse({ kind: 'asset', id: 'a1', versionId: 'v1' })).toHaveProperty(
      'versionId',
      'v1',
    );
    expect(() =>
      runtimeValueSchema.parse({ storage: 'inline', type: ImageType, value: new Uint8Array([1]) }),
    ).toThrow();
    expect(() =>
      runtimeValueSchema.parse({
        storage: 'reference',
        type: ImageType,
        reference: { kind: 'artifact', id: 'a', url: 'https://invalid.example' },
      }),
    ).toThrow();
  });
  it('Artifact 保留运行来源，Asset 独立来源与版本；域对象并不自动等于资产', () => {
    const time = '2026-10-19T00:00:00.000Z';
    const artifact = {
      id: 'art-1',
      projectId: 'p',
      workflowRunId: 'run',
      type: ImageType,
      contentKind: 'blob',
      storage: { provider: 'rustfs', key: 'art-1.png' },
      createdAt: time,
    };
    expect(artifactSchema.parse(artifact)).not.toHaveProperty('name');
    const asset = {
      id: 'asset-1',
      versionId: 'v1',
      projectId: 'p',
      type: { kind: 'named', name: 'story.character' },
      name: '林雪',
      source: { type: 'artifact', artifactId: 'art-1' },
      data: { storage: 'inline', value: { name: '林雪', appearance: '黑发' } },
      createdAt: time,
      updatedAt: time,
    };
    expect(assetSchema.parse(asset).data).toHaveProperty('storage', 'inline');
    expect(() =>
      artifactSchema.parse({ ...artifact, storage: { url: 'https://invalid.example/image.png' } }),
    ).toThrow();
  });
  it('执行种类必须明确，不把所有节点强行归为普通 action', () => {
    const manifest = {
      type: 'test.node',
      version: 1,
      metadata: { name: '测试', category: 'data' },
      inputs: [],
      outputs: [],
      config: [],
    };
    for (const executionKind of ['action', 'control', 'composite', 'interaction'])
      expect(nodeTypeManifestSchema.parse({ ...manifest, executionKind }).executionKind).toBe(
        executionKind,
      );
    expect(() => nodeTypeManifestSchema.parse(manifest)).toThrow();
  });
});
