import { Module } from '@nestjs/common';
import { DatabaseModule } from './infrastructure/database.service.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { AuthModule } from './auth/auth.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { PluginsModule } from './plugins/plugins.module.js';
import { AssetsModule } from './assets/assets.module.js';
import { RunsModule } from './runs/runs.module.js';
import { ChatModule } from './chat/chat.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    DatabaseModule,
    InfrastructureModule,
    AuthModule,
    WorkspacesModule,
    WorkflowsModule,
    PluginsModule,
    AssetsModule,
    RunsModule,
    ChatModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
