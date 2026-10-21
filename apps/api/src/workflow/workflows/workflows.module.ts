import { Module } from '@nestjs/common';
import { WorkflowService } from './workflow.service.js';
import { WorkflowNodeRegistryModule } from '@dramaflow/server';
import {
  ProjectWorkflowsController,
  WorkflowsController,
} from './workflows.controller.js';

@Module({
  imports: [WorkflowNodeRegistryModule],
  providers: [WorkflowService],
  controllers: [ProjectWorkflowsController, WorkflowsController],
  exports: [WorkflowService],
})
export class WorkflowsModule {}
