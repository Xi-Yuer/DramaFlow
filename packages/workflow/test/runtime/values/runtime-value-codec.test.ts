import { describe, expect, it, vi } from 'vitest';
import {
  ImageType,
  StringType,
  type DataReference,
  type InlineRuntimeValue,
  type ReferenceRuntimeValue,
  type RuntimeValue,
} from '@dramaflow/contracts';
import {
  DefaultRuntimeValueCodec,
  DefaultDataStoragePolicyResolver,
  type ArtifactWriter,
  ReferenceResolutionError,
  type DataReferenceResolver,
  type MediaResource,
  type RuntimeValueDecodeContext,
} from '../../../src/index.js';

const context: RuntimeValueDecodeContext = Object.freeze({
  projectId: 'project-1',
  workflowRunId: 'run-1',
});
const assetReference: DataReference = Object.freeze({
  kind: 'asset',
  id: 'asset-image',
  versionId: 'version-3',
});
const image: ReferenceRuntimeValue = Object.freeze({
  storage: 'reference',
  type: ImageType,
  reference: assetReference,
});
const media: MediaResource = {
  id: 'image-resource',
  mediaType: 'image',
  mimeType: 'image/png',
  size: 1024,
  access: { url: 'https://media.example.test/image?signature=test-only' },
};

function decodeCodec(resolver: DataReferenceResolver) {
  return new DefaultRuntimeValueCodec(
    resolver,
    { write: vi.fn<ArtifactWriter['write']>().mockRejectedValue(new Error('解码不应写入')) },
    {
      resolve: vi.fn().mockImplementation(() => {
        throw new Error('解码不应选择存储策略');
      }),
    },
  );
}

function encodingFixture() {
  const write = vi
    .fn<ArtifactWriter['write']>()
    .mockResolvedValue({ kind: 'artifact', id: 'artifact-1' });
  const resolve = vi
    .fn<DataReferenceResolver['resolve']>()
    .mockRejectedValue(new Error('编码不应读取引用'));
  const policy = new DefaultDataStoragePolicyResolver();
  const selectPolicy = vi.spyOn(policy, 'resolve');
  const codec = new DefaultRuntimeValueCodec({ resolve }, { write }, policy);
  const encodeContext = { ...context, nodeId: 'video', outputKey: 'result' };
  return { codec, write, resolve, selectPolicy, encodeContext };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('RuntimeValueCodec 单值解码', () => {
  it.each<{ value: InlineRuntimeValue['value'] }>([
    { value: '人物向前走' },
    { value: null },
    { value: false },
    { value: 0 },
    { value: '' },
    { value: [false, 0, null] },
    { value: { nested: ['业务值'] } },
  ])('inline 原样返回值，不解析引用或执行业务类型校验：$value', async ({ value }) => {
    const resolve = vi
      .fn<DataReferenceResolver['resolve']>()
      .mockRejectedValue(new Error('不应调用'));
    const codec = decodeCodec({ resolve });
    const runtimeValue: InlineRuntimeValue = Object.freeze({
      storage: 'inline',
      type: StringType,
      value,
    });
    expect(await codec.decode(runtimeValue, context)).toBe(value);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reference 只委托显式 Resolver，保留固定版本与最小上下文，返回业务媒体对象', async () => {
    const resolve = vi.fn<DataReferenceResolver['resolve']>().mockResolvedValue(media);
    const codec = decodeCodec({ resolve });
    expect(await codec.decode(image, context)).toBe(media);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(assetReference, context);
    expect(resolve.mock.calls[0]?.[0]).toBe(assetReference);
    expect(resolve.mock.calls[0]?.[1]).toBe(context);
    expect(image.reference).toEqual({ kind: 'asset', id: 'asset-image', versionId: 'version-3' });
  });

  it('不把领域对象强制转换为媒体、URL 或二进制，不执行 Schema 校验', async () => {
    const reference: DataReference = { kind: 'artifact', id: 'character-artifact' };
    const character = { name: '小林', traits: ['勇敢'] };
    const resolve = vi.fn<DataReferenceResolver['resolve']>().mockResolvedValue(character);
    const codec = decodeCodec({ resolve });
    expect(
      await codec.decode(
        { storage: 'reference', type: { kind: 'named', name: 'story.character' }, reference },
        context,
      ),
    ).toBe(character);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(reference, context);
  });

  it.each([new Error('内容服务不可用'), '引用解析失败'])(
    '异步引用解析失败时保留 cause 并标记结构化错误',
    async (cause) => {
      const resolve = vi.fn<DataReferenceResolver['resolve']>().mockRejectedValue(cause);
      const result = decodeCodec({ resolve }).decode(image, context);
      await expect(result).rejects.toBeInstanceOf(ReferenceResolutionError);
      await expect(result).rejects.toMatchObject({
        code: 'REFERENCE_RESOLUTION_FAILED',
        reference: assetReference,
        cause,
      });
    },
  );

  it('同步抛出的引用解析异常也属于引用失败，不伪装成输入校验失败', async () => {
    const cause = new Error('同步引用错误');
    const resolve = vi.fn<DataReferenceResolver['resolve']>().mockImplementation(() => {
      throw cause;
    });
    await expect(decodeCodec({ resolve }).decode(image, context)).rejects.toMatchObject({
      code: 'REFERENCE_RESOLUTION_FAILED',
      cause,
    });
  });

  it('Resolver 已提供结构化引用错误时原样传播，不重复包装', async () => {
    const error = new ReferenceResolutionError(assetReference, { cause: new Error('版本不可用') });
    const resolve = vi.fn<DataReferenceResolver['resolve']>().mockRejectedValue(error);
    await expect(decodeCodec({ resolve }).decode(image, context)).rejects.toBe(error);
  });
});

describe('RuntimeValueCodec 批量解码', () => {
  it('并行解析多个引用，完成顺序不改变输入键和值的对应关系', async () => {
    const characterReference: DataReference = { kind: 'artifact', id: 'character-artifact' };
    const character = { name: '小林' };
    const imageGate = deferred<unknown>();
    const characterGate = deferred<unknown>();
    const bothStarted = deferred<void>();
    const started = new Set<string>();
    const resolve = vi.fn<DataReferenceResolver['resolve']>().mockImplementation((reference) => {
      started.add(reference.id);
      if (started.size === 2) bothStarted.resolve();
      return reference.kind === 'asset' ? imageGate.promise : characterGate.promise;
    });
    const codec = decodeCodec({ resolve });
    const values: Readonly<Record<string, RuntimeValue>> = Object.freeze({
      prompt: Object.freeze({ storage: 'inline', type: StringType, value: '人物向前走' }),
      image,
      character: Object.freeze({
        storage: 'reference',
        type: { kind: 'named', name: 'story.character' },
        reference: characterReference,
      } satisfies ReferenceRuntimeValue),
    });
    const snapshot = structuredClone(values);
    const invocation = codec.decodeRecord(values, context);
    try {
      await bothStarted.promise;
      expect(resolve).toHaveBeenCalledTimes(2);
      characterGate.resolve(character);
      imageGate.resolve(media);
      const inputs = await invocation;
      expect(inputs).toEqual({ prompt: '人物向前走', image: media, character });
      expect(inputs.image).toBe(media);
      expect(inputs.character).toBe(character);
      expect(Object.keys(inputs)).toEqual(['prompt', 'image', 'character']);
      expect(values).toEqual(snapshot);
      for (const [, receivedContext] of resolve.mock.calls) expect(receivedContext).toBe(context);
    } finally {
      imageGate.resolve(media);
      characterGate.resolve(character);
      await invocation;
    }
  });

  it('空 map 返回空结果，不调用引用服务', async () => {
    const resolve = vi.fn<DataReferenceResolver['resolve']>();
    expect(await decodeCodec({ resolve }).decodeRecord({}, context)).toEqual({});
    expect(resolve).not.toHaveBeenCalled();
  });

  it('任一引用失败时整体失败，不返回缺失字段或部分业务输入', async () => {
    const cause = new Error('资产版本不存在');
    const resolve = vi.fn<DataReferenceResolver['resolve']>().mockRejectedValue(cause);
    await expect(
      decodeCodec({ resolve }).decodeRecord(
        { prompt: { storage: 'inline', type: StringType, value: '提示词' }, image },
        context,
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_RESOLUTION_FAILED', cause });
  });

  it('只处理自有输入键，保留原型相关键，不污染结果原型', async () => {
    const value: RuntimeValue = { storage: 'inline', type: StringType, value: '值' };
    const values = Object.fromEntries<RuntimeValue>([
      ['__proto__', value],
      ['constructor', value],
      ['toString', value],
    ]);
    Object.setPrototypeOf(values, { inherited: image });
    const resolve = vi.fn<DataReferenceResolver['resolve']>();
    const result = await decodeCodec({ resolve }).decodeRecord(values, context);
    expect(Object.keys(result)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result['__proto__']).toBe('值');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('RuntimeValueCodec 输出编码', () => {
  it.each([
    { value: '文本' },
    { value: 12.5 },
    { value: false },
    { value: null },
    { value: { nested: [1, '值'] } },
  ])(
    'inline 只包装可序列化值，不读写引用、不选择策略或做业务类型校验：$value',
    async ({ value }) => {
      const f = encodingFixture();
      expect(
        await f.codec.encode(value, {
          type: StringType,
          storagePolicy: 'inline',
          context: f.encodeContext,
        }),
      ).toEqual({ storage: 'inline', type: StringType, value });
      expect(f.write).not.toHaveBeenCalled();
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.selectPolicy).not.toHaveBeenCalled();
    },
  );

  it.each([
    { value: undefined },
    { value: Infinity },
    { value: new Uint8Array([1, 2]) },
    { value: new Date() },
    { value: { nested: undefined } },
  ])('inline 拒绝非 JSON 值，不隐式序列化、丢弃字段或改用 Artifact：$value', async ({ value }) => {
    const f = encodingFixture();
    await expect(
      f.codec.encode(value, {
        type: StringType,
        storagePolicy: 'inline',
        context: f.encodeContext,
      }),
    ).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
  });

  it('reference 只委托 ArtifactWriter，传递原始业务值、类型与输出定位，State 中仅留引用', async () => {
    const f = encodingFixture();
    const value = new Uint8Array([1, 2, 3]);
    const result = await f.codec.encode(value, {
      type: ImageType,
      storagePolicy: 'reference',
      context: f.encodeContext,
    });
    expect(result).toEqual({
      storage: 'reference',
      type: ImageType,
      reference: { kind: 'artifact', id: 'artifact-1' },
    });
    expect(f.write).toHaveBeenCalledExactlyOnceWith(value, { ...f.encodeContext, type: ImageType });
    expect(f.write.mock.calls[0]?.[0]).toBe(value);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.selectPolicy).not.toHaveBeenCalled();
  });

  it.each(['inline', 'reference'] as const)(
    'auto 将值和声明类型交给统一 Resolver，采用其 %s 结果',
    async (policy) => {
      const f = encodingFixture();
      f.selectPolicy.mockReturnValue(policy);
      const result = await f.codec.encode(media, {
        type: ImageType,
        storagePolicy: 'auto',
        context: f.encodeContext,
      });
      expect(f.selectPolicy).toHaveBeenCalledExactlyOnceWith(ImageType, media);
      expect(result.storage).toBe(policy);
      expect(f.write).toHaveBeenCalledTimes(policy === 'reference' ? 1 : 0);
    },
  );

  it('auto 策略缺失时失败，不创建 Artifact', async () => {
    const f = encodingFixture();
    await expect(
      f.codec.encode(
        {},
        {
          type: { kind: 'named', name: 'custom.unknown' },
          storagePolicy: 'auto',
          context: f.encodeContext,
        },
      ),
    ).rejects.toMatchObject({ code: 'DATA_STORAGE_POLICY_NOT_FOUND' });
    expect(f.write).not.toHaveBeenCalled();
  });

  it('Writer 失败保留 cause，且不回退 inline 或重试', async () => {
    const f = encodingFixture();
    const error = new Error('对象存储写入失败');
    f.write.mockRejectedValue(error);
    await expect(
      f.codec.encode(media, {
        type: ImageType,
        storagePolicy: 'reference',
        context: f.encodeContext,
      }),
    ).rejects.toBe(error);
    expect(f.write).toHaveBeenCalledTimes(1);
  });

  it('Writer 返回无效引用时拒绝生成 RuntimeValue', async () => {
    const f = encodingFixture();
    f.write.mockResolvedValue({ kind: 'artifact', id: '' });
    await expect(
      f.codec.encode(media, {
        type: ImageType,
        storagePolicy: 'reference',
        context: f.encodeContext,
      }),
    ).rejects.toThrow();
  });
});
