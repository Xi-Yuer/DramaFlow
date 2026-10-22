import type { DataReference } from '@dramaflow/contracts';
import type { RuntimeValueDecodeContext } from './runtime-value-codec.js';

// 具体实现负责项目授权、固定资产版本及内容访问；Codec 仅依赖此端口。
export interface DataReferenceResolver {
  resolve(reference: DataReference, context: RuntimeValueDecodeContext): Promise<unknown>;
}

// 媒体解码后的业务资源描述；临时 URL 不回写到 RuntimeValue 或持久输入快照。
export interface MediaResource {
  readonly id: string;
  readonly mediaType: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly access: { readonly url: string };
}

export class ReferenceResolutionError extends Error {
  readonly code = 'REFERENCE_RESOLUTION_FAILED';

  constructor(
    public readonly reference: DataReference,
    options?: ErrorOptions,
  ) {
    super('数据引用解析失败', options);
    this.name = 'ReferenceResolutionError';
  }
}
