import { Module } from '@nestjs/common';
import { RuntimeWorkerModule } from '@dramaflow/api/worker';

@Module({
  imports: [RuntimeWorkerModule],
})
export class AppModule {}
