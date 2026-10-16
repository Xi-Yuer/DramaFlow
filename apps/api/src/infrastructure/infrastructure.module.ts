import { Global, Module } from '@nestjs/common';
import { SecretsService } from './secrets.service.js';
import { RunQueue } from './queue.service.js';
@Global()
@Module({
  providers: [SecretsService, RunQueue],
  exports: [SecretsService, RunQueue],
})
export class InfrastructureModule {}
