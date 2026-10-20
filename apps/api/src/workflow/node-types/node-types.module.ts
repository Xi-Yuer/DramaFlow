import { WorkflowNodeRegistryModule } from '@dramaflow/server';
import { Module } from '@nestjs/common';
import { NodeTypesController } from './node-types.controller.js';

@Module({
  imports: [WorkflowNodeRegistryModule],
  controllers: [NodeTypesController],
  exports: [WorkflowNodeRegistryModule],
})
export class NodeTypesModule {}
