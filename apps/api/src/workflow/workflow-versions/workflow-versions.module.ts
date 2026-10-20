import { Module } from '@nestjs/common';
import { WorkflowVersionRepositories } from './workflow-version-repository.js';

@Module({
  providers: [WorkflowVersionRepositories],
  exports: [WorkflowVersionRepositories],
})
export class WorkflowVersionsModule {}
