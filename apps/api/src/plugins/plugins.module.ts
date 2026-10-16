import { Module } from '@nestjs/common';
import { PluginsController } from './plugins.controller.js';
import { PluginsService } from './plugins.service.js';
@Module({
  providers: [PluginsService],
  controllers: [PluginsController],
  exports: [PluginsService],
})
export class PluginsModule {}
