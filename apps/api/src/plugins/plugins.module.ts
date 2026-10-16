import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { PluginsController } from './plugins.controller.js';
import { PluginsService } from './plugins.service.js';

@Module({
  imports: [InfrastructureModule],
  providers: [PluginsService],
  controllers: [PluginsController],
})
export class PluginsModule {}
