import { Module } from '@nestjs/common';
import { WorkflowRunRepositories } from './workflow-run-repository.js';

@Module({
  providers: [WorkflowRunRepositories],
  exports: [WorkflowRunRepositories],
})
export class WorkflowRunsModule {}
