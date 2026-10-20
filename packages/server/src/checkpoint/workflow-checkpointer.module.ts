import { Module } from '@nestjs/common';
import { WorkflowCheckpointerService } from './workflow-checkpointer.service.js';

@Module({ providers: [WorkflowCheckpointerService], exports: [WorkflowCheckpointerService] })
export class WorkflowCheckpointerModule {}
