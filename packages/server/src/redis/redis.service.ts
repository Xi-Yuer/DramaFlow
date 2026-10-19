import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
  });

  async ping(): Promise<void> {
    await this.client.ping();
  }

  onModuleDestroy() {
    this.client.disconnect();
  }
}
