import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../../database/database.service.js';
import { WorkflowSubmissionModule } from '../submission/workflow-submission.module.js';
import { WorkflowRunQueryModule } from '../query/workflow-run-query.module.js';
import { WorkflowRunCancellationService } from './workflow-run-cancellation.service.js';

@Module({
  imports: [DatabaseModule, WorkflowSubmissionModule, WorkflowRunQueryModule],
  providers: [WorkflowRunCancellationService],
  exports: [WorkflowRunCancellationService],
})
export class WorkflowRunCancellationModule {}
