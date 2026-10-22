import type { ArtifactReference, DataType } from '@dramaflow/contracts';
import type { RuntimeValueEncodeContext } from './runtime-value-codec.js';

/** 节点返回的业务二进制内容；不含存储位置或平台引用。 */
export interface BinaryContent {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface ArtifactWriteContext extends RuntimeValueEncodeContext {
  readonly type: DataType;
}

// 实现负责授权、不可变 Artifact 与内容存储；成功持久化后才能返回引用。
export interface ArtifactWriter {
  write(value: unknown, context: ArtifactWriteContext): Promise<ArtifactReference>;
}
