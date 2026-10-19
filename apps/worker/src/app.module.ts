import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@dramaflow/server';

@Module({ imports: [InfrastructureModule] })
export class AppModule {}
