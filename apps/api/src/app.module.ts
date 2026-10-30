import { ModelManagementModule } from './models/model-management.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { VideosModule } from './videos/videos.module.js';
import { ProductWorkflowInvocationsModule } from './product-workflow-invocations/product-workflow-invocations.module.js';
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
    ModelManagementModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    VideosModule,
    ProductWorkflowInvocationsModule,
    NodeTypesModule,
    WorkflowRuntimeModule,
    WorkflowsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
