import {
  compositeDefinitionSchema,
  nodeDefinitionSchema,
  workflowDraftDefinitionSchema,
  type NodeDefinition,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import type { NodeChange } from '@xyflow/react';
import { z } from 'zod';
import type { WorkflowNode, WorkflowNodeData } from './types';

const reactFlowNodeSchema = z.object({
  id: nodeDefinitionSchema.shape.id,
  type: z.literal('workflowNode', { error: '无法导出未知的 React Flow 节点渲染器' }),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  data: z.object({
    nodeType: nodeDefinitionSchema.shape.type,
    typeVersion: nodeDefinitionSchema.shape.typeVersion,
    name: nodeDefinitionSchema.shape.name,
    inputs: nodeDefinitionSchema.shape.inputs,
    config: nodeDefinitionSchema.shape.config,
    preset: nodeDefinitionSchema.shape.preset,
    composite: compositeDefinitionSchema.optional(),
  }),
});

// React Flow 的 type 是渲染器标识；平台运行类型只放在 data.nodeType。
export function toReactFlowNode(input: unknown): WorkflowNode {
  const definition = nodeDefinitionSchema.parse(input);
  return structuredClone({
    id: definition.id,
    type: 'workflowNode',
    position: definition.ui.position,
    data: {
      nodeType: definition.type,
      typeVersion: definition.typeVersion,
      name: definition.name,
      inputs: definition.inputs,
      config: definition.config,
      ...(definition.preset !== undefined ? { preset: definition.preset } : {}),
      ...(definition.composite !== undefined ? { composite: definition.composite } : {}),
    },
  } satisfies WorkflowNode);
}

// 只导出领域字段及当前坐标，selected / dragging / measured 等不进入 DSL。
export function fromReactFlowNode(input: unknown): NodeDefinition {
  const node = reactFlowNodeSchema.parse(input);
  return nodeDefinitionSchema.parse({
    id: node.id,
    type: node.data.nodeType,
    typeVersion: node.data.typeVersion,
    name: node.data.name,
    inputs: node.data.inputs,
    config: node.data.config,
    ...(node.data.preset !== undefined ? { preset: node.data.preset } : {}),
    ...(node.data.composite !== undefined ? { composite: node.data.composite } : {}),
    ui: { position: node.position },
  });
}

// 卡片只有投影数据。这里补齐 resolveNodePorts 需要的实例，不作为草稿保存入口。
export function canvasNodeDefinition(id: string, data: WorkflowNodeData): NodeDefinition {
  return {
    id,
    type: data.nodeType,
    typeVersion: data.typeVersion,
    name: data.name,
    inputs: data.inputs,
    config: data.config,
    ui: { position: { x: 0, y: 0 } },
    ...(data.preset !== undefined ? { preset: data.preset } : {}),
    ...(data.composite !== undefined ? { composite: data.composite } : {}),
  };
}

export function toReactFlowNodes(input: unknown): WorkflowNode[] {
  return workflowDraftDefinitionSchema.parse(input).nodes.map(toReactFlowNode);
}

// 位置变更只更新领域布局；选择、测量、拖动标记及内部增删事件不进入 Definition。
export function applyWorkflowNodePositions(
  input: unknown,
  changes: readonly NodeChange<WorkflowNode>[],
): WorkflowDefinition {
  const workflow = workflowDraftDefinitionSchema.parse(input);
  for (const change of changes) {
    if (change.type !== 'position' || !change.position) continue;
    const node = workflow.nodes.find((node) => node.id === change.id);
    if (node)
      node.ui.position = z
        .object({ x: z.number().finite(), y: z.number().finite() })
        .parse(change.position);
  }
  return workflow;
}
