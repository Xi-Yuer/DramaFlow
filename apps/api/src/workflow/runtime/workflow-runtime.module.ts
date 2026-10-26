import {
  WorkflowSubmissionModule,
  WorkflowQueueModule,
  WorkflowHumanReviewModule,
  WorkflowExecutionTreeModule,
  WorkflowRunQueryModule,
} from '@dramaflow/server';
import { Module } from '@nestjs/common';
import { WorkflowRuntimeService } from '../runs/workflow-runtime.service.js';
import { WorkflowExecutionTreeController } from '../execution-tree/workflow-execution-tree.controller.js';
import { WorkflowRunsController } from '../runs/workflow-runs.controller.js';

@Module({
  imports: [
    WorkflowSubmissionModule,
    WorkflowQueueModule,
    WorkflowHumanReviewModule,
    WorkflowExecutionTreeModule,
    WorkflowRunQueryModule,
  ],
  providers: [WorkflowRuntimeService],
  controllers: [WorkflowRunsController, WorkflowExecutionTreeController],
  exports: [WorkflowRuntimeService],
})
export class WorkflowRuntimeModule {}
