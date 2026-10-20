import {
  WorkflowRuntimeInfrastructureModule,
  WorkflowQueueModule,
  WorkflowExecutionConsumer,
  WorkflowOutboxPump,
} from '@dramaflow/server';
import { Module } from '@nestjs/common';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';

@Module({
  imports: [WorkflowRuntimeInfrastructureModule, WorkflowQueueModule],
  providers: [
    WorkflowRuntimeService,
    WorkflowExecutionConsumer,
    WorkflowOutboxPump,
  ],
  exports: [WorkflowRuntimeService],
})
export class WorkflowRuntimeModule {}
