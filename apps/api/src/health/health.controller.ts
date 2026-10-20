import {
  DatabaseService,
  RedisService,
  StorageService,
  WorkflowCheckpointerService,
} from '@dramaflow/server';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/auth.guard.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly checkpointer: WorkflowCheckpointerService,
  ) {}
  @Get() async health() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([
          this.db.client.$queryRaw`SELECT 1`,
          this.redis.ping(),
          this.storage.ping(),
          this.checkpointer.ping(),
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ServiceUnavailableException('基础设施尚未就绪')),
            2500,
          );
        }),
      ]);
      return {
        status: 'ok',
        services: {
          postgres: 'up',
          redis: 'up',
          storage: 'up',
          checkpointer: 'up',
        },
      };
    } catch {
      throw new ServiceUnavailableException('基础设施尚未就绪');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
