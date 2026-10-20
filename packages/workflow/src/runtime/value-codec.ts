import type { DataType, RuntimeValue } from '@dramaflow/contracts';
import type { RuntimeValueDecodeContext } from './runtime-value-codec.js';

export interface RuntimeValueContext extends RuntimeValueDecodeContext {
  readonly nodeRunId?: string;
}

// 具体持久化与权限服务接入前不提供内存或本地文件的生产兜底。
export interface RuntimeValueEncoder {
  encode(value: unknown, type: DataType, context: RuntimeValueContext): Promise<RuntimeValue>;
}
