import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.service.js';
import { RedisService } from './redis/redis.service.js';
import { SecretsService } from './secrets/secrets.service.js';
import { StorageService } from './storage/storage.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [RedisService, StorageService, SecretsService],
  exports: [DatabaseModule, RedisService, StorageService, SecretsService],
})
export class InfrastructureModule {}
