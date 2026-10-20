import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@dramaflow/server';
import { WorkflowRuntimeModule } from './workflow/runtime/workflow-runtime.module.js';

@Module({ imports: [InfrastructureModule, WorkflowRuntimeModule] })
export class AppModule {}
