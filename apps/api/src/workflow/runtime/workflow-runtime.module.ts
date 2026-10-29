import {
  WorkflowSubmissionModule,
  WorkflowQueueModule,
  WorkflowHumanReviewModule,
  WorkflowExecutionTreeModule,
  WorkflowRunQueryModule,
  WorkflowRunCancellationModule,
} from '@dramaflow/server';
import { Module } from '@nestjs/common';
import { WorkflowRunCancellationController } from '../runs/workflow-run-cancellation.controller.js';
import { WorkflowRuntimeService } from '../runs/workflow-runtime.service.js';
import { WorkflowExecutionTreeController } from '../execution-tree/workflow-execution-tree.controller.js';
import {
  WorkflowRunsController,
  WorkflowRunHistoryController,
} from '../runs/workflow-runs.controller.js';

@Module({
  imports: [
    WorkflowSubmissionModule,
    WorkflowQueueModule,
    WorkflowHumanReviewModule,
    WorkflowExecutionTreeModule,
    WorkflowRunQueryModule,
    WorkflowRunCancellationModule,
  ],
  providers: [WorkflowRuntimeService],
  controllers: [
    WorkflowRunCancellationController,
    WorkflowRunHistoryController,
    WorkflowRunsController,
    WorkflowExecutionTreeController,
  ],
  exports: [WorkflowRuntimeService],
})
export class WorkflowRuntimeModule {}
