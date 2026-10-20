import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.service.js';
import { RedisService } from './redis/redis.service.js';
import { SecretsService } from './secrets/secrets.service.js';
import { StorageService } from './storage/storage.service.js';
import { WorkflowCheckpointerModule } from './checkpoint/workflow-checkpointer.module.js';

@Module({
  imports: [DatabaseModule, WorkflowCheckpointerModule],
  providers: [RedisService, StorageService, SecretsService],
  exports: [
    DatabaseModule,
    WorkflowCheckpointerModule,
    RedisService,
    StorageService,
    SecretsService,
  ],
})
export class InfrastructureModule {}
