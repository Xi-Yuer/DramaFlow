import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.service.js';
import { WorkflowExecutionQueue } from './workflow-execution-queue.js';
import { WorkflowOutboxDispatcher } from './workflow-outbox-dispatcher.js';
import { WorkflowCancellationReconciler } from './workflow-cancellation-reconciler.js';
import { WorkflowSubmissionModule } from '../run/submission/workflow-submission.module.js';

@Module({
  imports: [DatabaseModule, WorkflowSubmissionModule],
  providers: [WorkflowExecutionQueue, WorkflowOutboxDispatcher, WorkflowCancellationReconciler],
  exports: [WorkflowExecutionQueue, WorkflowOutboxDispatcher, WorkflowCancellationReconciler],
})
export class WorkflowQueueModule {}
