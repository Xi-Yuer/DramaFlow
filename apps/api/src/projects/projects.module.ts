import { Module } from '@nestjs/common';
import { StorageModule, WorkflowCheckpointerModule, WorkflowQueueModule } from '@dramaflow/server';
import { ProjectsService } from './projects.service.js';
import { ProjectsController } from './projects.controller.js';

@Module({
  imports: [StorageModule, WorkflowCheckpointerModule, WorkflowQueueModule],
  providers: [ProjectsService],
  controllers: [ProjectsController],
})
export class ProjectsModule {}
