import {
  artifactReferenceSchema,
  containsInlineMediaValue,
  inlineRuntimeValueSchema,
  type DataStoragePolicy,
  type DataType,
  type RuntimeValue,
} from '@dramaflow/contracts';
import type { ArtifactWriter } from './artifact-writer.js';
import { ReferenceResolutionError, type DataReferenceResolver } from './data-reference-resolver.js';
import type { DataStoragePolicyResolver } from './data-storage-policy-resolver.js';

export interface RuntimeValueDecodeContext {
  readonly projectId: string;
  readonly workflowRunId: string;
}

export interface RuntimeValueEncodeContext extends RuntimeValueDecodeContext {
  readonly nodeRunId?: string;
  readonly nodeId: string;
  readonly outputKey: string;
}

export interface RuntimeValueEncodeOptions {
  readonly type: DataType;
  readonly storagePolicy: DataStoragePolicy;
  readonly context: RuntimeValueEncodeContext;
}

export interface RuntimeValueCodec {
  encode(value: unknown, options: RuntimeValueEncodeOptions): Promise<RuntimeValue>;
  decode(value: RuntimeValue, context: RuntimeValueDecodeContext): Promise<unknown>;
  decodeRecord(
    values: Readonly<Record<string, RuntimeValue>>,
    context: RuntimeValueDecodeContext,
  ): Promise<Record<string, unknown>>;
}

export class DefaultRuntimeValueCodec implements RuntimeValueCodec {
  constructor(
    private readonly referenceResolver: DataReferenceResolver,
    private readonly artifactWriter: ArtifactWriter,
    private readonly storagePolicyResolver: DataStoragePolicyResolver,
  ) {}

  async encode(value: unknown, options: RuntimeValueEncodeOptions): Promise<RuntimeValue> {
    if (options.type.kind === 'array' && !Array.isArray(value)) {
      throw new Error('数组 encode 要求业务数组，不能传入 RuntimeValue envelope');
    }
    if (options.type.kind === 'array' && containsInlineMediaValue(options.type, value)) {
      // 不把 decode 产生的 MediaResource / 临时 URL 再写成 JSON Artifact。
      // 媒体需逐元素沿原有 BinaryContent encode 管线写入，再由 Builder 保留引用。
      throw new Error('媒体集合必须逐元素 encode 后通过 CollectionBuilder 构造');
    }
    const policy =
      options.storagePolicy === 'auto'
        ? this.storagePolicyResolver.resolve(options.type, value)
        : options.storagePolicy;
    if (policy === 'inline') {
      // 只检查可持久化 JSON 边界，业务输出 Schema 已由 NodeExecutor 校验。
      return inlineRuntimeValueSchema.parse({ storage: 'inline', type: options.type, value });
    }
    const reference = artifactReferenceSchema.parse(
      await this.artifactWriter.write(value, { ...options.context, type: options.type }),
    );
    return { storage: 'reference', type: options.type, reference };
  }

  async decode(value: RuntimeValue, context: RuntimeValueDecodeContext): Promise<unknown> {
    if (value.storage === 'inline') return value.value;
    if (value.storage === 'collection') {
      // 仅在真正 decode 时解析元素引用，顺序由 Promise.all 保持。
      return Promise.all(value.elements.map((element) => this.decode(element, context)));
    }

    try {
      return await this.referenceResolver.resolve(value.reference, context);
    } catch (error) {
      if (error instanceof ReferenceResolutionError) throw error;
      throw new ReferenceResolutionError(value.reference, { cause: error });
    }
  }

  async decodeRecord(
    values: Readonly<Record<string, RuntimeValue>>,
    context: RuntimeValueDecodeContext,
  ): Promise<Record<string, unknown>> {
    const entries = await Promise.all(
      Object.entries(values).map(
        async ([key, value]) => [key, await this.decode(value, context)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }
}
