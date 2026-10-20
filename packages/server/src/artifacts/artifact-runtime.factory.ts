import { DefaultDataStoragePolicyResolver, DefaultRuntimeValueCodec } from '@dramaflow/workflow';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { StorageService } from '../storage/storage.service.js';
import { ArtifactRepository } from './artifact-repository.js';
import { ArtifactWriterService } from './artifact-writer.service.js';
import { ArtifactDataReferenceResolver } from './data-reference-resolver.service.js';

@Injectable()
export class ArtifactRuntimeFactory {
  constructor(
    private readonly repository: ArtifactRepository,
    private readonly storage: StorageService,
    private readonly policies: DefaultDataStoragePolicyResolver,
  ) {}

  async forRun(
    ownerId: string,
    projectId: string,
    workflowRunId: string,
  ): Promise<DefaultRuntimeValueCodec> {
    const scope = { ownerId, projectId: z.uuid().parse(projectId), workflowRunId };
    await this.repository.authorize(scope);
    return new DefaultRuntimeValueCodec(
      new ArtifactDataReferenceResolver(this.repository, this.storage, scope),
      new ArtifactWriterService(this.repository, this.storage, scope),
      this.policies,
    );
  }
}
