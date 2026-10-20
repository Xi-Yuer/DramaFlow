import { randomUUID } from 'node:crypto';
import type { ArtifactReference } from '@dramaflow/contracts';
import type { ArtifactWriter, ArtifactWriteContext } from '@dramaflow/workflow';
import { StorageService } from '../storage/storage.service.js';
import { prepareArtifactContent } from './artifact-content.js';
import { ArtifactRepository, type ArtifactScope } from './artifact-repository.js';

export class ArtifactWriteError extends Error {
  readonly code = 'ARTIFACT_WRITE_FAILED';
  constructor(
    readonly stage: 'prepare' | 'register' | 'upload' | 'finalize',
    readonly artifactId: string,
    options: ErrorOptions,
  ) {
    super('产物持久化失败', options);
    this.name = 'ArtifactWriteError';
  }
}

export class ArtifactWriterService implements ArtifactWriter {
  constructor(
    private readonly repository: ArtifactRepository,
    private readonly storage: StorageService,
    private readonly scope: ArtifactScope,
  ) {}

  async write(value: unknown, context: ArtifactWriteContext): Promise<ArtifactReference> {
    const id = randomUUID();
    let stage: ArtifactWriteError['stage'] = 'prepare';
    try {
      const content = prepareArtifactContent(value, context.type);
      const key = `projects/${this.scope.projectId}/runs/${this.scope.workflowRunId}/artifacts/${id}`;
      stage = 'register';
      await this.repository.createWriting(this.scope, context, {
        id,
        storageKey: key,
        contentKind: content.contentKind,
        mimeType: content.mimeType,
        size: content.size,
        checksum: content.checksum,
      });
      stage = 'upload';
      try {
        await this.storage.put(key, content.bytes, content.mimeType);
      } catch (uploadError) {
        // PUT 也可能已被接收才断线；删除同一个专属 key，保留失败及清理结果。
        const errors: unknown[] = [uploadError];
        let cleanupRequired = false;
        try {
          await this.storage.delete(key);
        } catch (cleanupError) {
          cleanupRequired = true;
          errors.push(cleanupError);
        }
        try {
          await this.repository.markFailed(this.scope, id, cleanupRequired);
        } catch (recordingError) {
          errors.push(recordingError);
        }
        throw new AggregateError(errors, '对象上传失败，含补偿与记录结果');
      }
      stage = 'finalize';
      // 确认失败可能是提交结果未知，不能删除一个实际上已 ready 的对象。
      // 保留 writing / ready 行和专属 key 供核对，绝不返回引用或重跑业务节点。
      await this.repository.markReady(this.scope, id);
      return { kind: 'artifact', id };
    } catch (cause) {
      throw new ArtifactWriteError(stage, id, { cause });
    }
  }
}
