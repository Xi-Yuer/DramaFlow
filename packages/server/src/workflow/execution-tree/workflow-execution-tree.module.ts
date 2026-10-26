import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.service.js';
import { WorkflowExecutionTreeService } from './workflow-execution-tree.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [WorkflowExecutionTreeService],
  exports: [WorkflowExecutionTreeService],
})
export class WorkflowExecutionTreeModule {}
