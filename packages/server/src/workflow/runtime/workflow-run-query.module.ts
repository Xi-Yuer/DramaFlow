import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.service.js';
import { WorkflowRunQueryService } from './workflow-run-query.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [WorkflowRunQueryService],
  exports: [WorkflowRunQueryService],
})
export class WorkflowRunQueryModule {}
