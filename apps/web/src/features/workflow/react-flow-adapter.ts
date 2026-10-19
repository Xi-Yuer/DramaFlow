import {
  dataEdgeDefinitionSchema,
  isTypeAssignable,
  nodeDefinitionSchema,
  nodeTypeManifestListSchema,
  workflowDefinitionSchema,
  workflowIdentifierSchema,
  workflowPortNameSchema,
  type DataEdgeDefinition,
  type NodeDefinition,
  type NodeTypeManifest,
  type WorkflowDefinition,
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
export type WorkflowEdgeData = { kind: 'data' };
export type WorkflowEdge = Edge<WorkflowEdgeData>;

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
  }),
});

const connectionSchema = z.object({
  source: workflowIdentifierSchema,
  sourceHandle: workflowPortNameSchema,
  target: workflowIdentifierSchema,
  targetHandle: workflowPortNameSchema,
});

const reactFlowEdgeSchema = connectionSchema.extend({
  id: workflowIdentifierSchema,
  data: z.object({ kind: z.literal('data') }),
});

type WorkflowConnection = z.infer<typeof connectionSchema>;

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

export function toReactFlowNodes(input: unknown): WorkflowNode[] {
  return workflowDefinitionSchema.parse(input).nodes.map(toReactFlowNode);
}

// ID 与 Handle 直接映射；领域 edges 是连接关系的唯一来源。
export function toReactFlowEdge(input: unknown): WorkflowEdge {
  const edge = dataEdgeDefinitionSchema.parse(input);
  return {
    id: edge.id,
    source: edge.source.nodeId,
    sourceHandle: edge.source.portKey,
    target: edge.target.nodeId,
    targetHandle: edge.target.portKey,
    data: { kind: edge.kind },
  };
}

export function fromReactFlowEdge(input: unknown): DataEdgeDefinition {
  const edge = reactFlowEdgeSchema.parse(input);
  return dataEdgeDefinitionSchema.parse({
    id: edge.id,
    kind: edge.data.kind,
    source: { nodeId: edge.source, portKey: edge.sourceHandle },
    target: { nodeId: edge.target, portKey: edge.targetHandle },
  });
}

export function toReactFlowEdges(input: unknown): WorkflowEdge[] {
  return workflowDefinitionSchema.parse(input).edges.map(toReactFlowEdge);
}

function manifestFor(manifests: readonly NodeTypeManifest[], type: string, version: number) {
  return manifests.find((manifest) => manifest.type === type && manifest.version === version);
}

function addDataEdge(
  workflow: WorkflowDefinition,
  connection: WorkflowConnection,
  manifests: readonly NodeTypeManifest[],
  id: string,
): WorkflowDefinition {
  const source = workflow.nodes.find((node) => node.id === connection.source);
  if (!source) throw new Error('连线的来源节点不存在');
  const target = workflow.nodes.find((node) => node.id === connection.target);
  if (!target) throw new Error('连线的目标节点不存在');
  if (source.id === target.id) throw new Error('数据边不能连接自身');
  const sourceManifest = manifestFor(manifests, source.type, source.typeVersion);
  const targetManifest = manifestFor(manifests, target.type, target.typeVersion);
  if (!sourceManifest || !targetManifest) throw new Error('节点类型不可用');
  const output = sourceManifest.outputs.find((port) => port.key === connection.sourceHandle);
  if (!output) throw new Error('来源端口不存在');
  const inputPort = targetManifest.inputs.find((port) => port.key === connection.targetHandle);
  if (!inputPort) throw new Error('目标端口不存在');
  if (!isTypeAssignable(output.dataType, inputPort.dataType)) {
    throw new Error('端口类型不兼容');
  }
  if (
    workflow.edges.some(
      (edge) =>
        edge.target.nodeId === connection.target && edge.target.portKey === connection.targetHandle,
    )
  ) {
    throw new Error('目标输入端口已经存在连接');
  }
  // 显式连线替换该端口的静态来源，不在 inputs 重复保存连接。
  delete target.inputs[connection.targetHandle];
  workflow.edges.push({
    id,
    kind: 'data',
    source: { nodeId: connection.source, portKey: connection.sourceHandle },
    target: { nodeId: connection.target, portKey: connection.targetHandle },
  });
  return workflowDefinitionSchema.parse(workflow);
}

export function connectWorkflowNodes(
  input: unknown,
  connectionInput: unknown,
  manifestsInput: unknown,
): WorkflowDefinition {
  return addDataEdge(
    workflowDefinitionSchema.parse(input),
    connectionSchema.parse(connectionInput),
    nodeTypeManifestListSchema.parse(manifestsInput),
    `edge_${globalThis.crypto.randomUUID()}`,
  );
}

function matchesDataEdge(edge: DataEdgeDefinition, snapshot: DataEdgeDefinition) {
  return (
    edge.id === snapshot.id &&
    edge.kind === snapshot.kind &&
    edge.source.nodeId === snapshot.source.nodeId &&
    edge.source.portKey === snapshot.source.portKey &&
    edge.target.nodeId === snapshot.target.nodeId &&
    edge.target.portKey === snapshot.target.portKey
  );
}

// 删除事件可能来自旧视图；只删除 ID 与完整端点仍匹配的那条关系。
export function disconnectWorkflowEdge(input: unknown, edgeInput: unknown): WorkflowDefinition {
  const workflow = workflowDefinitionSchema.parse(input);
  const snapshot = fromReactFlowEdge(edgeInput);
  workflow.edges = workflow.edges.filter((edge) => !matchesDataEdge(edge, snapshot));
  return workflow;
}

// 重连先移除匹配的旧边再统一校验；失败不修改调用方，成功保留领域边 ID。
export function reconnectWorkflowEdge(
  input: unknown,
  edgeInput: unknown,
  connectionInput: unknown,
  manifestsInput: unknown,
): WorkflowDefinition {
  const workflow = workflowDefinitionSchema.parse(input);
  const snapshot = fromReactFlowEdge(edgeInput);
  const index = workflow.edges.findIndex((edge) => matchesDataEdge(edge, snapshot));
  if (index === -1) return workflow;
  workflow.edges.splice(index, 1);
  return addDataEdge(
    workflow,
    connectionSchema.parse(connectionInput),
    nodeTypeManifestListSchema.parse(manifestsInput),
    snapshot.id,
  );
}
