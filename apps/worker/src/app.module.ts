import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@dramaflow/api/infrastructure';

@Module({ imports: [InfrastructureModule] })
export class AppModule {}
