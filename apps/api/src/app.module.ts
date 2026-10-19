import { ProjectsModule } from './projects/projects.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { Module } from '@nestjs/common';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { HealthController } from './health.controller.js';
import { NodeTypesModule } from './workflow/node/node-types.module.js';

@Module({
  imports: [
    InfrastructureModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    NodeTypesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
