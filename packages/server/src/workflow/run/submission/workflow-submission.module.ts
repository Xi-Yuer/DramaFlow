import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.service.js';
import { WorkflowRunRepositories } from './workflow-run-repository.js';
import { WorkflowVersionRepositories } from './workflow-version-repository.js';
import { WorkflowRunSubmissionFactory } from './workflow-run-submission.factory.js';

@Module({
  imports: [DatabaseModule],
  providers: [WorkflowRunRepositories, WorkflowVersionRepositories, WorkflowRunSubmissionFactory],
  exports: [WorkflowRunRepositories, WorkflowVersionRepositories, WorkflowRunSubmissionFactory],
})
export class WorkflowSubmissionModule {}
