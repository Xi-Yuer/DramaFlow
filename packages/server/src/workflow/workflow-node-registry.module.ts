import { NodeRegistry, createTextGenerationNodeType } from '@dramaflow/workflow';
import { Module } from '@nestjs/common';

// 每个应用一个生产 Registry，目录与 Runtime 共享；这里只注册明确交付的业务类型。
@Module({
  providers: [
    { provide: NodeRegistry, useFactory: () => new NodeRegistry([createTextGenerationNodeType()]) },
  ],
  exports: [NodeRegistry],
})
export class WorkflowNodeRegistryModule {}
