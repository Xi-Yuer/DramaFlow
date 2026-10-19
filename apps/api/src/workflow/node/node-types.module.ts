import { NodeRegistry } from '@dramaflow/workflow';
import { Module } from '@nestjs/common';
import { NodeTypesController } from './node-types.controller.js';

@Module({
  providers: [
    {
      provide: NodeRegistry,
      useFactory: () => new NodeRegistry<object, object>(),
    },
  ],
  controllers: [NodeTypesController],
  exports: [NodeRegistry],
})
export class NodeTypesModule {}
