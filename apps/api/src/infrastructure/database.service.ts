import {
  Global,
  Injectable,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createDatabase } from '@dramaflow/database';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly client = createDatabase();
  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

@Global()
@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
