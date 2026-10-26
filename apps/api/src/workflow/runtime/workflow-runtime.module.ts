import {
  WorkflowSubmissionModule,
  WorkflowQueueModule,
  WorkflowHumanReviewModule,
  WorkflowExecutionTreeModule,
} from '@dramaflow/server';
import { Module } from '@nestjs/common';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';
import { WorkflowExecutionTreeController } from './workflow-execution-tree.controller.js';
import { WorkflowRunsController } from './workflow-runs.controller.js';

@Module({
  imports: [
    WorkflowSubmissionModule,
    WorkflowQueueModule,
    WorkflowHumanReviewModule,
    WorkflowExecutionTreeModule,
  ],
  providers: [WorkflowRuntimeService],
  controllers: [WorkflowRunsController, WorkflowExecutionTreeController],
  exports: [WorkflowRuntimeService],
})
export class WorkflowRuntimeModule {}
