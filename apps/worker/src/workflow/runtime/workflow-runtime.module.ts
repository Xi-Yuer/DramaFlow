import { WorkflowRuntimeInfrastructureModule } from '@dramaflow/server';
import { Module } from '@nestjs/common';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';

@Module({
  imports: [WorkflowRuntimeInfrastructureModule],
  providers: [WorkflowRuntimeService],
  exports: [WorkflowRuntimeService],
})
export class WorkflowRuntimeModule {}
