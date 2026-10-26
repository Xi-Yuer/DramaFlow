import type { NodeDefinition } from '@dramaflow/contracts';
import type { Edge, Node } from '@xyflow/react';

export type WorkflowNodeData = {
  nodeType: NodeDefinition['type'];
  typeVersion: NodeDefinition['typeVersion'];
  name: NodeDefinition['name'];
  inputs: NodeDefinition['inputs'];
  config: NodeDefinition['config'];
  preset?: NodeDefinition['preset'];
  // 仅供卡片解析动态端口。草稿保存仍以领域 Definition 为准，不从 React Flow 回写整图。
  composite?: NodeDefinition['composite'];
};

export type WorkflowNode = Node<WorkflowNodeData, 'workflowNode'>;
export type WorkflowEdgeData =
  | { kind: 'data' | 'control'; projection?: never }
  | { kind: 'data'; projection: 'candidate-input' | 'template-input' | 'workflow-input' };
export type WorkflowEdge = Edge<WorkflowEdgeData>;
