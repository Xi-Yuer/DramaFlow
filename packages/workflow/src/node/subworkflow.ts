import { z } from 'zod';
import type { NodeDeclaration } from './type.js';
export { isSubworkflowNodeManifest } from '@dramaflow/contracts';

// Definition / Manifest 身份；尚无执行策略，生产 Publish 必须拒绝。
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
        description: '在当前版本内固定调用一次内嵌图；尚未支持执行',
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
