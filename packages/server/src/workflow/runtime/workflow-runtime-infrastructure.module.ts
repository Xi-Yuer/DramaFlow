import { DefaultWorkflowOutputResolver } from '@dramaflow/workflow';
import { Module } from '@nestjs/common';
import { WorkflowCheckpointerModule } from '../../checkpoint/workflow-checkpointer.module.js';
import { DatabaseModule } from '../../database/database.service.js';
import { NodeRunRepositories } from './execution/node-run-repository.js';
import { ArtifactModule } from '../../artifacts/artifact.module.js';
import { ModelProviderModule } from '../../models/model-provider.module.js';
import { WorkflowNodeRegistryModule } from '../node/workflow-node-registry.module.js';
import { WorkflowExecutionService } from './workflow-execution.service.js';
import { WorkflowSubmissionModule } from '../run/submission/workflow-submission.module.js';
import { WorkflowRuntimeFactory } from './workflow-runtime.factory.js';

@Module({
  imports: [
    DatabaseModule,
    WorkflowCheckpointerModule,
    WorkflowNodeRegistryModule,
    WorkflowSubmissionModule,
    ArtifactModule,
    ModelProviderModule,
  ],
  providers: [
    NodeRunRepositories,
    DefaultWorkflowOutputResolver,
    WorkflowRuntimeFactory,
    WorkflowExecutionService,
  ],
  exports: [WorkflowRuntimeFactory, WorkflowSubmissionModule, WorkflowExecutionService],
})
export class WorkflowRuntimeInfrastructureModule {}
