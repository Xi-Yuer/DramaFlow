import {
  DefaultDataStoragePolicyResolver,
  DefaultRuntimeValueCodec,
  DefaultWorkflowOutputResolver,
} from '@dramaflow/workflow';
import { Module } from '@nestjs/common';
import { WorkflowCheckpointerModule } from '../checkpoint/workflow-checkpointer.module.js';
import { DatabaseModule } from '../database/database.service.js';
import { NodeRunRepositories } from './node-run-repository.js';
import {
  UnconfiguredArtifactWriter,
  UnconfiguredDataReferenceResolver,
} from './unconfigured-reference-runtime.js';
import { WorkflowNodeRegistryModule } from './workflow-node-registry.module.js';
import { WorkflowRunRepositories } from './workflow-run-repository.js';
import { WorkflowExecutionService } from './workflow-execution.service.js';
import { WorkflowRunSubmissionFactory } from './workflow-run-submission.factory.js';
import { WorkflowRuntimeFactory } from './workflow-runtime.factory.js';
import { WorkflowVersionRepositories } from './workflow-version-repository.js';

@Module({
  imports: [DatabaseModule, WorkflowCheckpointerModule, WorkflowNodeRegistryModule],
  providers: [
    NodeRunRepositories,
    WorkflowRunRepositories,
    WorkflowVersionRepositories,
    DefaultDataStoragePolicyResolver,
    DefaultWorkflowOutputResolver,
    UnconfiguredArtifactWriter,
    UnconfiguredDataReferenceResolver,
    {
      provide: DefaultRuntimeValueCodec,
      useFactory: (
        references: UnconfiguredDataReferenceResolver,
        artifacts: UnconfiguredArtifactWriter,
        policy: DefaultDataStoragePolicyResolver,
      ) => new DefaultRuntimeValueCodec(references, artifacts, policy),
      inject: [
        UnconfiguredDataReferenceResolver,
        UnconfiguredArtifactWriter,
        DefaultDataStoragePolicyResolver,
      ],
    },
    WorkflowRuntimeFactory,
    WorkflowRunSubmissionFactory,
    WorkflowExecutionService,
  ],
  exports: [WorkflowRuntimeFactory, WorkflowRunSubmissionFactory, WorkflowExecutionService],
})
export class WorkflowRuntimeInfrastructureModule {}
