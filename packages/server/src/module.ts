import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.service.js';
import { RedisService } from './redis/redis.service.js';
import { SecretsService } from './secrets/secrets.service.js';
import { StorageModule } from './storage/storage.module.js';
import { WorkflowCheckpointerModule } from './checkpoint/workflow-checkpointer.module.js';

@Module({
  imports: [DatabaseModule, WorkflowCheckpointerModule, StorageModule],
  providers: [RedisService, SecretsService],
  exports: [
    DatabaseModule,
    WorkflowCheckpointerModule,
    RedisService,
    StorageModule,
    SecretsService,
  ],
})
export class InfrastructureModule {}
