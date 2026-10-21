import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.service.js';
import { RedisService } from './redis/redis.service.js';
import { SecretsModule } from './secrets/secrets.module.js';
import { StorageModule } from './storage/storage.module.js';
import { WorkflowCheckpointerModule } from './checkpoint/workflow-checkpointer.module.js';

@Module({
  imports: [DatabaseModule, WorkflowCheckpointerModule, StorageModule, SecretsModule],
  providers: [RedisService],
  exports: [DatabaseModule, WorkflowCheckpointerModule, RedisService, StorageModule, SecretsModule],
})
export class InfrastructureModule {}
