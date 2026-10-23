import { workflowIdentifierSchema, type NodeTypeManifest } from '@dramaflow/contracts';
import { z } from 'zod';
import type { NodeDeclaration } from './type.js';

export const mergeConfigSchema = z.object({ openerNodeId: workflowIdentifierSchema }).strict();

export function isMergeManifest(manifest: NodeTypeManifest): boolean {
  return (
    manifest.type === 'flow.merge' && manifest.version === 1 && manifest.executionKind === 'control'
  );
}

// 仅声明显式控制区域边界；无业务数据、Action execute 或生产编译策略。
export function createMergeNodeType(): NodeDeclaration {
  return {
    manifest: {
      type: 'flow.merge',
      version: 1,
      executionKind: 'control',
      metadata: {
        name: '分支汇聚',
        category: 'flow',
        description: '关闭配对的互斥控制区域（尚不可发布执行）',
      },
      inputs: [],
      outputs: [],
      config: [{ key: 'openerNodeId', name: '配对控制节点', type: 'string', required: true }],
    },
    inputSchema: z.object({}).strict(),
    configSchema: mergeConfigSchema,
    outputSchema: z.object({}).strict(),
  };
}
