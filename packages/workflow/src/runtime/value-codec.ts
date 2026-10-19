import type { DataReference, DataType, RuntimeValue } from '@dramaflow/contracts';

export interface RuntimeValueContext {
  readonly projectId: string;
  readonly workflowRunId: string;
  readonly nodeRunId?: string;
}

// 具体持久化与权限服务接入前不提供内存或本地文件的生产兜底。
export interface RuntimeValueCodec {
  encode(value: unknown, type: DataType, context: RuntimeValueContext): Promise<RuntimeValue>;
  decode(
    value: RuntimeValue,
    expectedType: DataType,
    context: RuntimeValueContext,
  ): Promise<unknown>;
}

export interface ResolvedMediaObject {
  readonly reference: DataReference;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly access: { readonly url?: string };
}
