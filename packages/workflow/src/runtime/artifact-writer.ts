import type { ArtifactReference, DataType } from '@dramaflow/contracts';
import type { RuntimeValueEncodeContext } from './runtime-value-codec.js';

export interface ArtifactWriteContext extends RuntimeValueEncodeContext {
  readonly type: DataType;
}

// 实现负责授权、不可变 Artifact 与内容存储；成功持久化后才能返回引用。
export interface ArtifactWriter {
  write(value: unknown, context: ArtifactWriteContext): Promise<ArtifactReference>;
}
