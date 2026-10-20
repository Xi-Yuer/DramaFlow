import { Module } from '@nestjs/common';
import { WorkflowService } from './workflow.service.js';

@Module({ providers: [WorkflowService], exports: [WorkflowService] })
export class WorkflowsModule {}
