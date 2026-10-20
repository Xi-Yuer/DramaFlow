import {
  WorkflowSubmissionModule,
  WorkflowQueueModule,
} from '@dramaflow/server';
import { Module } from '@nestjs/common';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';
import { WorkflowRunsController } from './workflow-runs.controller.js';

@Module({
  imports: [WorkflowSubmissionModule, WorkflowQueueModule],
  providers: [WorkflowRuntimeService],
  controllers: [WorkflowRunsController],
  exports: [WorkflowRuntimeService],
})
export class WorkflowRuntimeModule {}
