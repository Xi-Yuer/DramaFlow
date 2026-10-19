import {
  edgeDefinitionSchema,
  nodeDefinitionSchema,
  type EdgeDefinition,
  type NodeDefinition,
} from '@dramaflow/contracts';
import type { Edge, Node } from '@xyflow/react';
import { z } from 'zod';

export type WorkflowNodeData = {
  nodeType: NodeDefinition['type'];
  typeVersion: NodeDefinition['typeVersion'];
  name: NodeDefinition['name'];
  inputs: NodeDefinition['inputs'];
  config: NodeDefinition['config'];
  preset?: NodeDefinition['preset'];
};

export type WorkflowNode = Node<WorkflowNodeData, 'workflowNode'>;
export type WorkflowEdge = Edge;

const reactFlowNodeSchema = z.object({
  id: nodeDefinitionSchema.shape.id,
  type: z.literal('workflowNode', { error: '无法导出未知的 React Flow 节点渲染器' }),
  position: nodeDefinitionSchema.shape.ui.unwrap().shape.position,
  data: z.object({
    nodeType: nodeDefinitionSchema.shape.type,
    typeVersion: nodeDefinitionSchema.shape.typeVersion,
    name: nodeDefinitionSchema.shape.name,
    inputs: nodeDefinitionSchema.shape.inputs,
    config: nodeDefinitionSchema.shape.config,
    preset: nodeDefinitionSchema.shape.preset,
  }),
});

const reactFlowEdgeSchema = z.object({
  id: edgeDefinitionSchema.shape.id,
  source: edgeDefinitionSchema.shape.sourceNodeId,
  sourceHandle: edgeDefinitionSchema.shape.sourceHandle,
  target: edgeDefinitionSchema.shape.targetNodeId,
  targetHandle: edgeDefinitionSchema.shape.targetHandle,
});

// React Flow 的 type 是渲染器标识；平台运行类型只放在 data.nodeType。
export function toReactFlowNode(input: unknown): WorkflowNode {
  const definition = nodeDefinitionSchema.parse(input);
  return structuredClone({
    id: definition.id,
    type: 'workflowNode',
    position: definition.ui?.position ?? { x: 0, y: 0 },
    data: {
      nodeType: definition.type,
      typeVersion: definition.typeVersion,
      name: definition.name,
      inputs: definition.inputs,
      config: definition.config,
      ...(definition.preset !== undefined ? { preset: definition.preset } : {}),
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
    ui: { position: node.position },
  });
}

export function toReactFlowEdge(input: unknown): WorkflowEdge {
  const definition = edgeDefinitionSchema.parse(input);
  return {
    id: definition.id,
    source: definition.sourceNodeId,
    sourceHandle: definition.sourceHandle,
    target: definition.targetNodeId,
    targetHandle: definition.targetHandle,
  };
}

// 未指定端口的临时连线不能被猜测为可保存的完整映射。
export function fromReactFlowEdge(input: unknown): EdgeDefinition {
  const edge = reactFlowEdgeSchema.parse(input);
  return edgeDefinitionSchema.parse({
    id: edge.id,
    sourceNodeId: edge.source,
    sourceHandle: edge.sourceHandle,
    targetNodeId: edge.target,
    targetHandle: edge.targetHandle,
  });
}
