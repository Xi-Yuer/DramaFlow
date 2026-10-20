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
  ReferenceResolutionError,
  type DataReferenceResolver,
  type MediaResource,
  type RuntimeValueDecodeContext,
} from '../src/index.js';

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
    const codec = new DefaultRuntimeValueCodec({ resolve });
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
    const codec = new DefaultRuntimeValueCodec({ resolve });
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
    const codec = new DefaultRuntimeValueCodec({ resolve });
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
      const result = new DefaultRuntimeValueCodec({ resolve }).decode(image, context);
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
    await expect(
      new DefaultRuntimeValueCodec({ resolve }).decode(image, context),
    ).rejects.toMatchObject({
      code: 'REFERENCE_RESOLUTION_FAILED',
      cause,
    });
  });

  it('Resolver 已提供结构化引用错误时原样传播，不重复包装', async () => {
    const error = new ReferenceResolutionError(assetReference, { cause: new Error('版本不可用') });
    const resolve = vi.fn<DataReferenceResolver['resolve']>().mockRejectedValue(error);
    await expect(new DefaultRuntimeValueCodec({ resolve }).decode(image, context)).rejects.toBe(
      error,
    );
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
    const codec = new DefaultRuntimeValueCodec({ resolve });
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
    expect(await new DefaultRuntimeValueCodec({ resolve }).decodeRecord({}, context)).toEqual({});
    expect(resolve).not.toHaveBeenCalled();
  });

  it('任一引用失败时整体失败，不返回缺失字段或部分业务输入', async () => {
    const cause = new Error('资产版本不存在');
    const resolve = vi.fn<DataReferenceResolver['resolve']>().mockRejectedValue(cause);
    await expect(
      new DefaultRuntimeValueCodec({ resolve }).decodeRecord(
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
    const result = await new DefaultRuntimeValueCodec({ resolve }).decodeRecord(values, context);
    expect(Object.keys(result)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result['__proto__']).toBe('值');
    expect(resolve).not.toHaveBeenCalled();
  });
});
