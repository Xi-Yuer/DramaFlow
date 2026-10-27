import { WorkflowNodeRegistryModule } from '@dramaflow/server';
import { Module } from '@nestjs/common';
import {
  NodeCatalogController,
  NodeTypesController,
} from './node-types.controller.js';

@Module({
  imports: [WorkflowNodeRegistryModule],
  controllers: [NodeTypesController, NodeCatalogController],
  exports: [WorkflowNodeRegistryModule],
})
export class NodeTypesModule {}
