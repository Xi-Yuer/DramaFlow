import {
  NodeRegistry,
  createTextGenerationNodeType,
  createFormatTextNodeType,
  createIfNodeType,
  createIterationNodeType,
  createSubworkflowNodeType,
  createHumanReviewNodeType,
} from '@dramaflow/workflow';
import { Module } from '@nestjs/common';

// 每个应用一个生产 Registry；Catalog 通过 Manifest metadata 显式选择暴露范围。
// 注册不代表产品可创建，也不代表已通过发布 / 执行准入。
@Module({
  providers: [
    {
      provide: NodeRegistry,
      useFactory: () =>
        new NodeRegistry([
          createTextGenerationNodeType(),
          createFormatTextNodeType(),
          createIfNodeType(),
          createIterationNodeType(),
          createSubworkflowNodeType(),
          createHumanReviewNodeType(),
        ]),
    },
  ],
  exports: [NodeRegistry],
})
export class WorkflowNodeRegistryModule {}
