import { AnyType } from '@dramaflow/contracts';
import { z } from 'zod';
import type { NodeDeclaration } from './type.js';

export { isIterationNodeManifest } from '@dramaflow/contracts';

// 仅声明与注册；没有 execute，不代表 Compiler 已支持运行。
export function createIterationNodeType(): NodeDeclaration {
  return {
    manifest: {
      type: 'flow.iteration',
      version: 1,
      executionKind: 'composite',
      portDerivation: 'iteration',
      metadata: {
        name: '逐项处理',
        category: 'flow',
        description: '固定集合中每个元素调用局部 body，按原位置聚合声明输出；空集合不执行 body',
      },
      inputs: [
        {
          key: 'items',
          name: '集合',
          dataType: { kind: 'array', itemType: AnyType },
          required: true,
        },
      ],
      outputs: [],
      config: [],
    },
    inputSchema: z.object({ items: z.array(z.unknown()) }).strict(),
    outputSchema: z.object({}).strict(),
    configSchema: z.object({}).strict(),
  };
}
