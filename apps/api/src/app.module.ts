import { ProjectsModule } from './projects/projects.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { Module } from '@nestjs/common';
import { InfrastructureModule, ModelProviderModule } from '@dramaflow/server';
import { HealthController } from './health/health.controller.js';
import { NodeTypesModule } from './workflow/node-types/node-types.module.js';
import { WorkflowRuntimeModule } from './workflow/runtime/workflow-runtime.module.js';
import { WorkflowsModule } from './workflow/workflows/workflows.module.js';

@Module({
  imports: [
    InfrastructureModule,
    ModelProviderModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    NodeTypesModule,
    WorkflowRuntimeModule,
    WorkflowsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
