import { Module } from '@nestjs/common';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';
@Module({
  providers: [RunsService],
  controllers: [RunsController],
  exports: [RunsService],
})
export class RunsModule {}
