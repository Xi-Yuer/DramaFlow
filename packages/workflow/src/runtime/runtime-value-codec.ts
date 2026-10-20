import {
  artifactReferenceSchema,
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
