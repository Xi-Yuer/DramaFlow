import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './infrastructure/database.service.js';
import { RunQueue } from './infrastructure/queue.service.js';
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly queue: RunQueue,
  ) {}
  @Get() async health() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([this.db.client.$queryRaw`SELECT 1`, this.queue.ping()]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ServiceUnavailableException('基础设施尚未就绪')), 2500);
        }),
      ]);
      return { status: 'ok' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
