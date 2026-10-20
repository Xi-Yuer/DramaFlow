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
import { WorkflowExecutionService } from './workflow-execution.service.js';
import { WorkflowSubmissionModule } from './workflow-submission.module.js';
import { WorkflowRuntimeFactory } from './workflow-runtime.factory.js';

@Module({
  imports: [
    DatabaseModule,
    WorkflowCheckpointerModule,
    WorkflowNodeRegistryModule,
    WorkflowSubmissionModule,
  ],
  providers: [
    NodeRunRepositories,
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
    WorkflowExecutionService,
  ],
  exports: [WorkflowRuntimeFactory, WorkflowSubmissionModule, WorkflowExecutionService],
})
export class WorkflowRuntimeInfrastructureModule {}
