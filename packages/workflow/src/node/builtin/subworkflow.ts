import { z } from 'zod';
import type { NodeDeclaration } from '../registry/type.js';
export { isSubworkflowNodeManifest } from '@dramaflow/contracts';

// 固定单次内嵌图调用；由独立 Composite Strategy 执行，不提供 Action execute。
export function createSubworkflowNodeType(): NodeDeclaration {
  return {
    manifest: {
      type: 'flow.subworkflow',
      version: 1,
      executionKind: 'composite',
      portDerivation: 'subworkflow',
      metadata: {
        name: '子流程',
        category: 'flow',
        description: '在当前版本内固定调用一次普通 Action 子图',
      },
      inputs: [],
      outputs: [],
      config: [],
    },
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({}).strict(),
    configSchema: z.object({}).strict(),
  };
}
