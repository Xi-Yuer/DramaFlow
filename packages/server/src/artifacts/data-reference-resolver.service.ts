import { createHash } from 'node:crypto';
import type { DataReference } from '@dramaflow/contracts';
import {
  ReferenceResolutionError,
  type DataReferenceResolver,
  type MediaResource,
  type RuntimeValueDecodeContext,
} from '@dramaflow/workflow';
import { z } from 'zod';
import { StorageService } from '../storage/storage.service.js';
import { ArtifactRepository, type ArtifactScope } from './artifact-repository.js';

export class ArtifactDataReferenceResolver implements DataReferenceResolver {
  constructor(
    private readonly repository: ArtifactRepository,
    private readonly storage: StorageService,
    private readonly scope: ArtifactScope,
  ) {}

  async resolve(reference: DataReference, context: RuntimeValueDecodeContext): Promise<unknown> {
    try {
      if (reference.kind === 'asset')
        throw Object.assign(new Error('尚未配置资产版本内容服务'), {
          code: 'ASSET_REFERENCE_NOT_CONFIGURED',
        });
      const artifact = await this.repository.getReady(this.scope, reference.id, context);
      if (artifact.contentKind === 'json') {
        const bytes = await this.storage.get(artifact.storage.key);
        if (
          bytes.byteLength !== artifact.storage.size ||
          createHash('sha256').update(bytes).digest('hex') !== artifact.storage.checksum
        )
          throw new Error('产物内容校验失败');
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        return z.json().parse(value);
      }
      // 签名不证明对象存在；先向私有存储确认，缺失时在 decode_input 边界失败。
      const head = await this.storage.head(artifact.storage.key);
      if (head.size !== artifact.storage.size || head.mimeType !== artifact.storage.mimeType)
        throw new Error('产物对象元数据不一致');
      const resource: MediaResource = {
        id: artifact.id,
        mediaType:
          artifact.type.kind === 'named' && artifact.type.name.startsWith('media.')
            ? artifact.type.name.slice('media.'.length)
            : 'file',
        mimeType: artifact.storage.mimeType,
        size: artifact.storage.size,
        access: { url: await this.storage.signedGetUrl(artifact.storage.key) },
      };
      return resource;
    } catch (cause) {
      throw new ReferenceResolutionError(reference, { cause });
    }
  }
}
