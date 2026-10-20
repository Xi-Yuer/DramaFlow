import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.service.js';
import { WorkflowExecutionQueue } from './workflow-execution-queue.js';
import { WorkflowOutboxDispatcher } from './workflow-outbox-dispatcher.js';

@Module({
  imports: [DatabaseModule],
  providers: [WorkflowExecutionQueue, WorkflowOutboxDispatcher],
  exports: [WorkflowExecutionQueue, WorkflowOutboxDispatcher],
})
export class WorkflowQueueModule {}
