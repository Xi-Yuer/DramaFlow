import { Module } from '@nestjs/common';
import { WorkflowService } from './workflow.service.js';
import { WorkflowNodeRegistryModule } from '@dramaflow/server';

@Module({
  imports: [WorkflowNodeRegistryModule],
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowsModule {}
