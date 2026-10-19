import {
  controlEdgeDefinitionSchema,
  isTypeAssignable,
  nodeDefinitionSchema,
  nodeTypeManifestListSchema,
  workflowDefinitionSchema,
  workflowIdentifierSchema,
  workflowPortNameSchema,
  type ControlEdgeDefinition,
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
export type WorkflowEdgeData = { kind: 'data' } | { kind: 'control' };
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

const reactFlowEdgeSchema = z.object({
  id: z.string(),
  source: workflowIdentifierSchema,
  sourceHandle: workflowPortNameSchema.nullish(),
  target: workflowIdentifierSchema,
  targetHandle: workflowPortNameSchema.nullish(),
  data: z.object({ kind: z.enum(['data', 'control']) }),
});

// 独立命名空间和 JSON 元组避免控制边 ID、端口分隔符与数据边 ID 碰撞。
function dataEdgeId(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return `data:${JSON.stringify([source, sourceHandle, target, targetHandle])}`;
}

function controlEdgeId(id: string) {
  return `control:${JSON.stringify(id)}`;
}

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

export function toReactFlowControlEdge(input: unknown): WorkflowEdge {
  const edge = controlEdgeDefinitionSchema.parse(input);
  return {
    id: controlEdgeId(edge.id),
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    data: { kind: 'control' },
  };
}

export function toReactFlowEdges(input: unknown): WorkflowEdge[] {
  const workflow = workflowDefinitionSchema.parse(input);
  const dataEdges: WorkflowEdge[] = workflow.nodes.flatMap((node) =>
    Object.entries(node.inputs).flatMap(([targetHandle, binding]) => {
      if (binding.type !== 'connection') return [];
      return [
        {
          id: dataEdgeId(binding.nodeId, binding.outputKey, node.id, targetHandle),
          source: binding.nodeId,
          sourceHandle: binding.outputKey,
          target: node.id,
          targetHandle,
          data: { kind: 'data' as const },
        },
      ];
    }),
  );
  return [...dataEdges, ...workflow.edges.map(toReactFlowControlEdge)];
}

function manifestFor(manifests: readonly NodeTypeManifest[], type: string, version: number) {
  return manifests.find((manifest) => manifest.type === type && manifest.version === version);
}

// 用户明确连线时才替换该输入端口的原绑定；端口和类型必须能在传入的目录里对上。
export function connectWorkflowNodes(
  input: unknown,
  connectionInput: unknown,
  manifestsInput: unknown,
): WorkflowDefinition {
  const workflow = workflowDefinitionSchema.parse(input);
  const connection = connectionSchema.parse(connectionInput);
  const manifests = nodeTypeManifestListSchema.parse(manifestsInput);
  const source = workflow.nodes.find((node) => node.id === connection.source);
  if (!source) throw new Error('连线的来源节点不存在');
  const target = workflow.nodes.find((node) => node.id === connection.target);
  if (!target) throw new Error('连线的目标节点不存在');
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
  target.inputs[connection.targetHandle] = {
    type: 'connection',
    nodeId: connection.source,
    outputKey: connection.sourceHandle,
  };
  return workflowDefinitionSchema.parse(workflow);
}

function matchesControlEdge(
  edge: ControlEdgeDefinition,
  snapshot: z.infer<typeof reactFlowEdgeSchema>,
) {
  return (
    controlEdgeId(edge.id) === snapshot.id &&
    edge.sourceNodeId === snapshot.source &&
    edge.targetNodeId === snapshot.target &&
    snapshot.sourceHandle == null &&
    snapshot.targetHandle == null
  );
}

// 删除事件可能来自旧视图；只删除 ID 与完整端点仍匹配的那条关系。
export function disconnectWorkflowEdge(input: unknown, edgeInput: unknown): WorkflowDefinition {
  const workflow = workflowDefinitionSchema.parse(input);
  const edge = reactFlowEdgeSchema.parse(edgeInput);
  if (edge.data.kind === 'control') {
    workflow.edges = workflow.edges.filter((item) => !matchesControlEdge(item, edge));
    return workflow;
  }
  if (
    !edge.sourceHandle ||
    !edge.targetHandle ||
    edge.id !== dataEdgeId(edge.source, edge.sourceHandle, edge.target, edge.targetHandle)
  ) {
    return workflow;
  }
  const target = workflow.nodes.find((node) => node.id === edge.target);
  const binding = target?.inputs[edge.targetHandle];
  if (
    target &&
    binding?.type === 'connection' &&
    binding.nodeId === edge.source &&
    binding.outputKey === edge.sourceHandle
  ) {
    delete target.inputs[edge.targetHandle];
  }
  return workflow;
}
