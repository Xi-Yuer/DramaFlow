import { Module } from '@nestjs/common';
import { DatabaseModule } from '../infrastructure/database.service.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PluginsModule } from '../plugins/plugins.module.js';
import { AssetsModule } from '../assets/assets.module.js';
import { RuntimeHostService } from './runtime-host.service.js';
import { ExecutionService } from './execution.service.js';

export { ExecutionService };
export { redisConnection } from '../infrastructure/queue.service.js';
@Module({
  imports: [
    DatabaseModule,
    InfrastructureModule,
    AuthModule,
    PluginsModule,
    AssetsModule,
  ],
  providers: [RuntimeHostService, ExecutionService],
  exports: [ExecutionService],
})
export class RuntimeWorkerModule {}
