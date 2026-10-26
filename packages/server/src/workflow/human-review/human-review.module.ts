import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.service.js';
import { WorkflowCheckpointerModule } from '../../checkpoint/workflow-checkpointer.module.js';
import { WorkflowHumanReviewService } from './human-review.service.js';

@Module({
  imports: [DatabaseModule, WorkflowCheckpointerModule],
  providers: [WorkflowHumanReviewService],
  exports: [WorkflowHumanReviewService],
})
export class WorkflowHumanReviewModule {}
