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
import { NodeCatalog, createBuiltinNodeCatalogEntries } from './node-catalog.js';

// 每个应用一个生产 Registry；产品 Catalog 独立声明条目与目标类型。
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
    {
      provide: NodeCatalog,
      useFactory: (registry: NodeRegistry) =>
        new NodeCatalog(createBuiltinNodeCatalogEntries(), registry),
      inject: [NodeRegistry],
    },
  ],
  exports: [NodeRegistry, NodeCatalog],
})
export class WorkflowNodeRegistryModule {}
