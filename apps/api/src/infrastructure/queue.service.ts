import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

export function redisConnection() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    db: Number(url.pathname.slice(1) || 0),
  };
}

@Injectable()
export class RunQueue implements OnModuleDestroy {
  private readonly queue = new Queue('dramaflow-runs', {
    connection: redisConnection(),
  });
  async ping(): Promise<string> {
    await this.queue.waitUntilReady();
    return 'PONG';
  }
  async wake(runId: string, triggerId: string): Promise<void> {
    await this.queue.add(
      'wake-run',
      { runId },
      {
        jobId: `${runId}-${triggerId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 604800, count: 5000 },
      },
    );
  }
  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
