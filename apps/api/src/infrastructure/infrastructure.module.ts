import { Module } from '@nestjs/common';
import { DatabaseModule, DatabaseService } from './database.service.js';
import { RedisService } from './redis.service.js';
import { StorageService } from './storage.service.js';
import { SecretsService } from './secrets.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [RedisService, StorageService, SecretsService],
  exports: [DatabaseModule, RedisService, StorageService, SecretsService],
})
export class InfrastructureModule {}

export { DatabaseService, RedisService, StorageService };
