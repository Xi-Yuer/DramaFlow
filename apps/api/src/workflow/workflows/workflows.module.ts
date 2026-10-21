import { Module } from '@nestjs/common';
import { WorkflowService } from './workflow.service.js';
import {
  WorkflowNodeRegistryModule,
  ModelProviderModule,
} from '@dramaflow/server';
import {
  ProjectWorkflowsController,
  WorkflowsController,
  WorkflowVersionsController,
} from './workflows.controller.js';

@Module({
  imports: [WorkflowNodeRegistryModule, ModelProviderModule],
  providers: [WorkflowService],
  controllers: [
    ProjectWorkflowsController,
    WorkflowsController,
    WorkflowVersionsController,
  ],
  exports: [WorkflowService],
})
export class WorkflowsModule {}
