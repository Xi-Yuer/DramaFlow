import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller.js';
import { AssetsService } from './assets.service.js';
import { StorageService } from './storage.service.js';
@Module({
  providers: [AssetsService, StorageService],
  controllers: [AssetsController],
  exports: [AssetsService],
})
export class AssetsModule {}
