import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { nodeRunRepositoryFixture } from '../../fixtures/node-run-fixture.js';
import {
  collectionRuntimeValueSchema,
  runtimeValueSchema,
  StringType,
  NumberType,
  ImageType,
  type RuntimeValue,
  type DataType,
  type CollectionRuntimeValue,
} from '@dramaflow/contracts';
import {
  RuntimeCollectionSnapshot,
  OrderedRuntimeCollectionBuilder,
  DefaultRuntimeValueCodec,
  DefaultDataStoragePolicyResolver,
  mapGraphInvocationInputs,
  createLocalGraphInvocation,
  WorkflowInvocationContractValidator,
  ReferenceResolutionError,
  DefaultWorkflowOutputResolver,
  DefaultNodeExecutor,
  NodeRegistry,
  createBindingResolver,
  type ArtifactWriter,
  type DataReferenceResolver,
} from '../../../src/index.js';

const context = { projectId: 'project', workflowRunId: 'run' };
const encodeContext = { ...context, nodeId: 'process', outputKey: 'result' };
const array = (itemType: DataType): DataType => ({ kind: 'array', itemType });
const inline = (type: DataType, value: unknown): RuntimeValue =>
  runtimeValueSchema.parse({ storage: 'inline', type, value });
const image: RuntimeValue = {
  storage: 'reference',
  type: ImageType,
  reference: { kind: 'artifact', id: 'image-1' },
};
const secondImage: RuntimeValue = { ...image, reference: { kind: 'artifact', id: 'image-2' } };
const mediaCollection: CollectionRuntimeValue = {
  storage: 'collection',
  type: { kind: 'array', itemType: ImageType },
  elements: [image, secondImage],
};
function fixture() {
  const resolve = vi
    .fn<DataReferenceResolver['resolve']>()
    .mockRejectedValue(new Error('不应读取'));
  const write = vi
    .fn<ArtifactWriter['write']>()
    .mockResolvedValue({ kind: 'artifact', id: 'container' });
  const policy = new DefaultDataStoragePolicyResolver();
  const codec = new DefaultRuntimeValueCodec({ resolve }, { write }, policy);
  return { codec, resolve, write, policy };
}

describe('集合 snapshot', () => {
  it.each([
    [StringType, []],
    [StringType, ['A', 'B', 'A']],
    [{ kind: 'object', properties: { name: StringType } } satisfies DataType, [{ name: 'A' }]],
    [array(NumberType), [[1, 2], [3]]],
  ])('inline snapshot 保留元素类型、顺序和重复 slot', async (itemType, values) => {
    const f = fixture();
    const value = inline(array(itemType), values);
    const original = JSON.stringify(value);
    const snapshot = await RuntimeCollectionSnapshot.create(value, f.codec, context);
    expect(snapshot.length).toBe(values.length);
    values.forEach((item, index) => {
      expect(snapshot.get(index)).toEqual({ storage: 'inline', type: itemType, value: item });
      expect(snapshot.get(index)).toBe(snapshot.get(index));
    });
    expect(JSON.stringify(value)).toBe(original);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('防御来源/元素变异，并明确拒绝越界、非整数和非数组', async () => {
    const f = fixture();
    const value = inline(array(StringType), ['A', 'A']);
    const snapshot = await RuntimeCollectionSnapshot.create(value, f.codec, context);
    if (value.storage === 'inline' && Array.isArray(value.value)) value.value.push('B');
    expect(snapshot.length).toBe(2);
    expect(snapshot.get(0)).not.toBe(snapshot.get(1));
    expect(() => Object.assign(snapshot.get(0), { value: 'changed' })).toThrow();
    for (const index of [-1, 2, 0.5, NaN, Infinity])
      expect(() => snapshot.get(index)).toThrow('INDEX_OUT_OF_BOUNDS');
    await expect(
      RuntimeCollectionSnapshot.create(inline(StringType, 'x'), f.codec, context),
    ).rejects.toThrow('NOT_ARRAY');
    await expect(
      RuntimeCollectionSnapshot.create(inline(array(StringType), 'wrong'), f.codec, context),
    ).rejects.toThrow('INVALID_CONTAINER');
  });
  it('整体 reference 容器只读取一次，get 不再访问 resolver，可持久化后恢复', async () => {
    const f = fixture();
    f.resolve.mockResolvedValue(['A', 'B']);
    const value: RuntimeValue = {
      storage: 'reference',
      type: array(StringType),
      reference: { kind: 'artifact', id: 'chapters' },
    };
    const snapshot = await RuntimeCollectionSnapshot.create(value, f.codec, context);
    expect(snapshot.get(1)).toEqual(inline(StringType, 'B'));
    snapshot.get(0);
    snapshot.get(1);
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(value.reference, context);
    const persisted = runtimeValueSchema.parse(
      JSON.parse(JSON.stringify(snapshot.toRuntimeValue())),
    );
    const restored = await RuntimeCollectionSnapshot.create(persisted, f.codec, context);
    expect(restored.get(0)).toEqual(snapshot.get(0));
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });
  it('reference failure 保留标准错误；错误容器失败', async () => {
    const f = fixture();
    const source: RuntimeValue = {
      storage: 'reference',
      type: array(StringType),
      reference: { kind: 'artifact', id: 'bad' },
    };
    await expect(RuntimeCollectionSnapshot.create(source, f.codec, context)).rejects.toBeInstanceOf(
      ReferenceResolutionError,
    );
    f.resolve.mockResolvedValue({ not: 'array' });
    await expect(RuntimeCollectionSnapshot.create(source, f.codec, context)).rejects.toThrow(
      'INVALID_CONTAINER',
    );
  });
  it('元素 references 不触发 I/O，可序列化并保留固定版本', async () => {
    const f = fixture();
    const asset: RuntimeValue = {
      storage: 'reference',
      type: ImageType,
      reference: { kind: 'asset', id: 'asset', versionId: 'v1' },
    };
    const snapshot = await RuntimeCollectionSnapshot.create(
      { ...mediaCollection, elements: [image, asset] },
      f.codec,
      context,
    );
    expect(snapshot.get(0)).toEqual(image);
    expect(snapshot.get(1)).toEqual(asset);
    expect(runtimeValueSchema.parse(JSON.parse(JSON.stringify(snapshot.toRuntimeValue())))).toEqual(
      { ...mediaCollection, elements: [image, asset] },
    );
    expect(JSON.stringify(snapshot.toRuntimeValue())).not.toContain('url');
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('拒绝将媒体业务资源包装为 inline 集合', async () => {
    const f = fixture();
    const raw = inline(array(ImageType), [{ access: { url: 'temporary' } }]);
    await expect(RuntimeCollectionSnapshot.create(raw, f.codec, context)).rejects.toThrow(
      'MEDIA_REFERENCE_REQUIRED',
    );
    expect(f.resolve).not.toHaveBeenCalled();
    const empty = await RuntimeCollectionSnapshot.create(
      inline(array(ImageType), []),
      f.codec,
      context,
    );
    expect(empty.length).toBe(0);
  });
});

describe('Ordered collection builder 与 Contract', () => {
  it('empty 合法，乱序完成不改变顺序，全 inline 可压缩为业务 JSON 数组', () => {
    expect(new OrderedRuntimeCollectionBuilder(StringType, 0).build()).toEqual(
      inline(array(StringType), []),
    );
    const builder = new OrderedRuntimeCollectionBuilder(StringType, 3);
    builder.add(2, inline(StringType, 'C'));
    builder.add(0, inline(StringType, 'A'));
    builder.add(1, inline(StringType, 'B'));
    expect(builder.build()).toEqual(inline(array(StringType), ['A', 'B', 'C']));
    expect(builder.build()).toEqual(builder.build());
  });
  it('duplicate、missing、越界与类型错误明确失败', () => {
    const builder = new OrderedRuntimeCollectionBuilder(StringType, 2);
    expect(() => builder.add(0, inline(NumberType, 1))).toThrow('ELEMENT_TYPE_MISMATCH');
    builder.add(0, inline(StringType, 'A'));
    expect(() => builder.add(0, inline(StringType, 'B'))).toThrow('DUPLICATE_INDEX');
    expect(() => builder.add(2, inline(StringType, 'B'))).toThrow('INDEX_OUT_OF_BOUNDS');
    expect(() => builder.build()).toThrow('MISSING_INDEX');
    expect(() => new OrderedRuntimeCollectionBuilder(StringType, -1)).toThrow();
  });
  it('nested array 不 flatten，窄元素实际类型不会因 inline 优化丢失', () => {
    const nested = new OrderedRuntimeCollectionBuilder(array(NumberType), 2);
    nested.add(1, inline(array(NumberType), [3]));
    nested.add(0, inline(array(NumberType), [1, 2]));
    expect(nested.build()).toEqual(inline(array(array(NumberType)), [[1, 2], [3]]));
    const union: DataType = { kind: 'union', types: [StringType, NumberType] };
    const typed = new OrderedRuntimeCollectionBuilder(union, 1);
    typed.add(0, inline(StringType, 'A'));
    expect(typed.build()).toEqual({
      storage: 'collection',
      type: array(union),
      elements: [inline(StringType, 'A')],
    });
  });
  it('media references 与 nested collection 均保留，不读取媒体或产生 URL', () => {
    const f = fixture();
    const builder = new OrderedRuntimeCollectionBuilder(ImageType, 2);
    builder.add(1, secondImage);
    builder.add(0, image);
    expect(builder.build()).toEqual(mediaCollection);
    const nested = new OrderedRuntimeCollectionBuilder(array(ImageType), 1);
    nested.add(0, builder.build());
    expect(nested.build()).toEqual({
      storage: 'collection',
      type: array(array(ImageType)),
      elements: [mediaCollection],
    });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(nested.build())).not.toContain('url');
    expect(() => builder.add(0, inline(ImageType, { access: { url: 'bad' } }))).toThrow();
  });
  it('Zod 拒绝混淆的集合、额外字段、元素类型不兼容、inline media', () => {
    expect(collectionRuntimeValueSchema.safeParse(mediaCollection).success).toBe(true);
    for (const value of [
      { ...mediaCollection, type: StringType },
      { ...mediaCollection, value: [] },
      { ...mediaCollection, elements: [inline(StringType, 'bad')] },
      { ...mediaCollection, elements: [inline(ImageType, { access: { url: 'bad' } })] },
      {
        ...mediaCollection,
        elements: [{ ...image, reference: { kind: 'artifact', id: 'image', url: 'bad' } }],
      },
    ])
      expect(collectionRuntimeValueSchema.safeParse(value).success).toBe(false);
  });
  it('普通 JSON 数组中的 envelope 不被猜成引用', async () => {
    const f = fixture();
    const value = inline(array({ kind: 'any' }), [image]);
    const snapshot = await RuntimeCollectionSnapshot.create(value, f.codec, context);
    expect(snapshot.get(0)).toEqual({ storage: 'inline', type: { kind: 'any' }, value: image });
    expect(f.resolve).not.toHaveBeenCalled();
  });
});

describe('Codec 与 storage 边界', () => {
  it('inline/整体 reference/元素 reference 均 decode 为业务数组', async () => {
    const f = fixture();
    expect(await f.codec.decode(inline(array(StringType), ['A']), context)).toEqual(['A']);
    f.resolve.mockResolvedValueOnce(['B']);
    expect(
      await f.codec.decode(
        {
          storage: 'reference',
          type: array(StringType),
          reference: { kind: 'artifact', id: 'all' },
        },
        context,
      ),
    ).toEqual(['B']);
    f.resolve.mockImplementation(async (ref) => ({
      id: ref.id,
      mediaType: 'image',
      access: { url: `temporary:${ref.id}` },
    }));
    const nested: RuntimeValue = {
      storage: 'collection',
      type: { kind: 'array', itemType: array(ImageType) },
      elements: [mediaCollection],
    };
    expect(await f.codec.decode(nested, context)).toEqual([
      [
        { id: 'image-1', mediaType: 'image', access: { url: 'temporary:image-1' } },
        { id: 'image-2', mediaType: 'image', access: { url: 'temporary:image-2' } },
      ],
    ]);
    expect(JSON.stringify(nested)).not.toContain('temporary');
  });
  it('元素解析失败保留标准错误', async () => {
    const f = fixture();
    await expect(f.codec.decode(mediaCollection, context)).rejects.toBeInstanceOf(
      ReferenceResolutionError,
    );
  });
  it('JSON array 显式 inline / reference 保持原管线，auto 不猜阈值', async () => {
    const f = fixture();
    expect(
      await f.codec.encode(['A'], {
        type: array(StringType),
        storagePolicy: 'inline',
        context: encodeContext,
      }),
    ).toEqual(inline(array(StringType), ['A']));
    expect(
      await f.codec.encode(['A'], {
        type: array(StringType),
        storagePolicy: 'reference',
        context: encodeContext,
      }),
    ).toEqual({
      storage: 'reference',
      type: array(StringType),
      reference: { kind: 'artifact', id: 'container' },
    });
    expect(f.write).toHaveBeenCalledExactlyOnceWith(['A'], {
      ...encodeContext,
      type: array(StringType),
    });
    await expect(
      f.codec.encode(['A'], {
        type: array(StringType),
        storagePolicy: 'auto',
        context: encodeContext,
      }),
    ).rejects.toThrow('尚未声明自动存储策略');
  });
  it('拒绝将解码后的媒体数组按 inline/reference 再编码为 JSON', async () => {
    const f = fixture();
    for (const storagePolicy of ['inline', 'reference', 'auto'] as const)
      await expect(
        f.codec.encode([{ id: 'image', access: { url: 'temporary' } }], {
          type: array(ImageType),
          storagePolicy,
          context: encodeContext,
        }),
      ).rejects.toThrow('媒体集合必须逐元素');
    expect(f.write).not.toHaveBeenCalled();
  });
  it('媒体逐元素 encode 可沿现有 BinaryContent Writer 进入 builder', async () => {
    const f = fixture();
    const bytes = new Uint8Array([1, 2]);
    const value = await f.codec.encode(
      { bytes, mimeType: 'image/png' },
      { type: ImageType, storagePolicy: 'auto', context: encodeContext },
    );
    const builder = new OrderedRuntimeCollectionBuilder(ImageType, 1);
    builder.add(0, value);
    expect(builder.build()).toEqual({
      storage: 'collection',
      type: array(ImageType),
      elements: [value],
    });
    expect(f.resolve).not.toHaveBeenCalled();
  });
});

describe('Graph Invocation 组合与调用校验', () => {
  it('snapshot.get 的 RuntimeValue 原样成为局部 workflow_input', async () => {
    const f = fixture();
    const snapshot = await RuntimeCollectionSnapshot.create(mediaCollection, f.codec, context);
    const value = snapshot.get(0);
    const inputs = [{ name: 'image', type: ImageType, required: true }];
    const mappings = [{ source: 'selected', target: 'image' }];
    expect(mapGraphInvocationInputs(inputs, { selected: value }, mappings).image).toBe(value);
    const local = createLocalGraphInvocation({
      definition: { inputs, nodes: [], edges: [], outputs: [] },
      definitionLocation: { workflowVersionId: 'version', path: [] },
      scopeKey: 'root',
      run: { ...context, workflowId: 'workflow', workflowVersionId: 'version' },
      sources: { selected: value },
      mappings,
    });
    expect(local.state.inputs.image).toBe(value);
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it('调用校验递归检查 inline 内容，不读取 collection 中的引用', () => {
    const validator = new WorkflowInvocationContractValidator();
    expect(
      validator.validate([{ name: 'images', type: array(ImageType), required: true }], {
        images: mediaCollection,
      }).images,
    ).toEqual(mediaCollection);
    const invalid: RuntimeValue = {
      storage: 'collection',
      type: { kind: 'array', itemType: NumberType },
      elements: [inline(NumberType, 'bad')],
    };
    expect(() =>
      validator.validate([{ name: 'items', type: array(NumberType), required: true }], {
        items: invalid,
      }),
    ).toThrow('内联内容不符合');
  });
});

it('builder 固定输入副本，混合表示保持类型并直接通过统一 OutputResolver', () => {
  const value = inline(StringType, 'A');
  const builder = new OrderedRuntimeCollectionBuilder(StringType, 2);
  builder.add(0, value);
  if (value.storage === 'inline') value.value = 'changed';
  builder.add(1, {
    storage: 'reference',
    type: StringType,
    reference: { kind: 'artifact', id: 'text' },
  });
  const result = builder.build();
  expect(result).toEqual({
    storage: 'collection',
    type: array(StringType),
    elements: [
      inline(StringType, 'A'),
      { storage: 'reference', type: StringType, reference: { kind: 'artifact', id: 'text' } },
    ],
  });
  const resolved = new DefaultWorkflowOutputResolver().resolve(
    {
      outputs: [
        {
          name: 'texts',
          type: array(StringType),
          source: { nodeId: 'collect', outputKey: 'result' },
        },
      ],
    },
    { outputs: { collect: { result } } },
  );
  expect(resolved.texts).toBe(result);
});

it('嵌套空媒体数组不含媒体业务值，无需引用或 materialize', async () => {
  const f = fixture();
  const builder = new OrderedRuntimeCollectionBuilder(array(ImageType), 1);
  builder.add(0, new OrderedRuntimeCollectionBuilder(ImageType, 0).build());
  const value = builder.build();
  expect(value).toEqual(inline(array(array(ImageType)), [[]]));
  const snapshot = await RuntimeCollectionSnapshot.create(value, f.codec, context);
  expect(snapshot.get(0)).toEqual(inline(array(ImageType), []));
  expect(
    await f.codec.encode([[]], {
      type: array(array(ImageType)),
      storagePolicy: 'inline',
      context: encodeContext,
    }),
  ).toEqual(value);
  expect(f.resolve).not.toHaveBeenCalled();
});

it('统一 Action 管线先记录集合 RuntimeValue，随后 decode 为业务数组再执行', async () => {
  const f = fixture();
  f.resolve.mockImplementation(async (ref) => ({
    id: ref.id,
    access: { url: `temporary:${ref.id}` },
  }));
  const execute = vi.fn(async (input: unknown) => {
    expect(input).toEqual({
      images: [
        { id: 'image-1', access: { url: 'temporary:image-1' } },
        { id: 'image-2', access: { url: 'temporary:image-2' } },
      ],
    });
    return { count: 2 };
  });
  const registry = new NodeRegistry([
    {
      manifest: {
        type: 'test.count_images',
        version: 1,
        executionKind: 'action',
        metadata: { name: '计数', category: 'data' },
        inputs: [{ key: 'images', name: '图片', dataType: array(ImageType) }],
        outputs: [{ key: 'count', name: '数量', dataType: NumberType }],
        config: [],
      },
      inputSchema: z.object({
        images: z.array(z.object({ id: z.string(), access: z.object({ url: z.string() }) })),
      }),
      configSchema: z.object({}),
      outputSchema: z.object({ count: z.number() }),
      execute,
    },
  ]);
  const nodeRuns = nodeRunRepositoryFixture();
  const local = createLocalGraphInvocation({
    definition: {
      inputs: [{ name: 'images', type: array(ImageType), required: true }],
      nodes: [
        {
          id: 'count',
          type: 'test.count_images',
          typeVersion: 1,
          name: '计数',
          inputs: { images: { type: 'workflow_input', key: 'images' } },
          config: {},
          ui: { position: { x: 0, y: 0 } },
        },
      ],
      edges: [],
      outputs: [],
    },
    definitionLocation: { workflowVersionId: 'version', path: [] },
    scopeKey: 'root',
    run: { ...context, workflowId: 'workflow', workflowVersionId: 'version' },
    sources: { images: mediaCollection },
    mappings: [{ source: 'images', target: 'images' }],
  });
  const executor = new DefaultNodeExecutor(registry, createBindingResolver(), f.codec, nodeRuns);
  const result = await executor.execute(local.definition.nodes[0]!, {
    ...context,
    scopeKey: local.scopeKey,
    workflow: local.definition,
    state: local.state,
  });
  expect(result.output.count).toEqual(inline(NumberType, 2));
  expect(nodeRuns.updateInputs).toHaveBeenCalledWith('node-run-1', { images: mediaCollection });
  expect(JSON.stringify(nodeRuns.updateInputs.mock.calls)).not.toContain('temporary');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(f.resolve).toHaveBeenCalledTimes(2);
  expect(f.write).not.toHaveBeenCalled();
});

it('Codec encode 不把 collection envelope 当作业务数组写入 Artifact', async () => {
  const f = fixture();
  await expect(
    f.codec.encode(mediaCollection, {
      type: array(ImageType),
      storagePolicy: 'reference',
      context: encodeContext,
    }),
  ).rejects.toThrow('业务数组');
  expect(f.write).not.toHaveBeenCalled();
});
