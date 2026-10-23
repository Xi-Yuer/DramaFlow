import {
  NodeRegistry,
  createTextGenerationNodeType,
  createIfNodeType,
  createHumanReviewNodeType,
} from '@dramaflow/workflow';
import { Module } from '@nestjs/common';

// 每个应用一个生产 Registry，目录与 Runtime 共享；注册声明不代表已支持发布执行。
@Module({
  providers: [
    {
      provide: NodeRegistry,
      useFactory: () =>
        new NodeRegistry([
          createTextGenerationNodeType(),
          createIfNodeType(),
          createHumanReviewNodeType(),
        ]),
    },
  ],
  exports: [NodeRegistry],
})
export class WorkflowNodeRegistryModule {}
