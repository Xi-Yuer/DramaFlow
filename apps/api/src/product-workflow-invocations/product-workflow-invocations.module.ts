import { Module } from '@nestjs/common';
import { WorkflowSubmissionModule } from '@dramaflow/server';
import { WorkflowRuntimeModule } from '../workflow/runtime/workflow-runtime.module.js';
import { ProductWorkflowInvocationsService } from './product-workflow-invocations.service.js';
import {
  ProductWorkflowInvocationsController,
  VideoWorkflowInvocationsController,
} from './product-workflow-invocations.controller.js';

@Module({
  imports: [WorkflowSubmissionModule, WorkflowRuntimeModule],
  controllers: [ProductWorkflowInvocationsController, VideoWorkflowInvocationsController],
  providers: [ProductWorkflowInvocationsService],
})
export class ProductWorkflowInvocationsModule {}
