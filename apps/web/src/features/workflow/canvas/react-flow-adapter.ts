import {
  controlEdgeDefinitionSchema,
  dataEdgeDefinitionSchema,
  isTypeAssignable,
  nodeDefinitionSchema,
  nodeTypeManifestListSchema,
  workflowDraftDefinitionSchema,
  workflowEdgeSchema,
  workflowIdentifierSchema,
  type WorkflowEdge as WorkflowEdgeDefinition,
  type NodeDefinition,
  type NodeTypeManifest,
  type StaticInputBinding,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import type { Edge, Node, NodeChange } from '@xyflow/react';
import { z } from 'zod';
import { controlHandleId, parseWorkflowHandle } from './workflow-handles';

export type WorkflowNodeData = {
  nodeType: NodeDefinition['type'];
  typeVersion: NodeDefinition['typeVersion'];
  name: NodeDefinition['name'];
  inputs: NodeDefinition['inputs'];
  config: NodeDefinition['config'];
  preset?: NodeDefinition['preset'];
};

export type WorkflowNode = Node<WorkflowNodeData, 'workflowNode'>;
export type WorkflowEdgeData = { kind: 'data' | 'control' };
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
  sourceHandle: z.string().min(1),
  target: workflowIdentifierSchema,
  targetHandle: z.string().min(1),
});

const reactFlowEdgeSchema = connectionSchema.extend({
  id: workflowIdentifierSchema,
  sourceHandle: z.string().nullish(),
  targetHandle: z.string().nullish(),
  data: z.object({ kind: z.enum(['data', 'control']) }),
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

// 默认控制 Handle 是 UI 标识；命名控制端口保留方向命名空间并无损映射。
export function controlEdgeToReactFlowEdge(input: unknown): WorkflowEdge {
  const edge = controlEdgeDefinitionSchema.parse(input);
  return {
    id: edge.id,
    source: edge.source.nodeId,
    sourceHandle: controlHandleId('source', edge.source.portKey),
    target: edge.target.nodeId,
    targetHandle: controlHandleId('target', edge.target.portKey),
    data: { kind: 'control' },
    style: { strokeDasharray: '5 4' },
  };
}

// 领域 edges 是两类连接的唯一来源；数据端口仍直接使用 portKey。
export function toReactFlowEdge(input: unknown): WorkflowEdge {
  const edge = workflowEdgeSchema.parse(input);
  if (edge.kind === 'control') return controlEdgeToReactFlowEdge(edge);
  return {
    id: edge.id,
    source: edge.source.nodeId,
    sourceHandle: edge.source.portKey,
    target: edge.target.nodeId,
    targetHandle: edge.target.portKey,
    data: { kind: edge.kind },
  };
}

export function fromReactFlowEdge(input: unknown): WorkflowEdgeDefinition {
  const edge = reactFlowEdgeSchema.parse(input);
  if (edge.data.kind === 'control') {
    const source = parseWorkflowHandle(edge.sourceHandle ?? controlHandleId('source'), 'source');
    const target = parseWorkflowHandle(edge.targetHandle ?? controlHandleId('target'), 'target');
    if (source.kind !== 'control' || target.kind !== 'control') {
      throw new Error('控制边只能连接控制端口');
    }
    return controlEdgeDefinitionSchema.parse({
      id: edge.id,
      kind: 'control',
      source: {
        nodeId: edge.source,
        ...(source.portKey !== undefined ? { portKey: source.portKey } : {}),
      },
      target: {
        nodeId: edge.target,
        ...(target.portKey !== undefined ? { portKey: target.portKey } : {}),
      },
    });
  }
  return dataEdgeDefinitionSchema.parse({
    id: edge.id,
    kind: edge.data.kind,
    source: { nodeId: edge.source, portKey: edge.sourceHandle },
    target: { nodeId: edge.target, portKey: edge.targetHandle },
  });
}

export function toReactFlowEdges(input: unknown): WorkflowEdge[] {
  return workflowDraftDefinitionSchema.parse(input).edges.map(toReactFlowEdge);
}

function manifestFor(manifests: readonly NodeTypeManifest[], type: string, version: number) {
  return manifests.find((manifest) => manifest.type === type && manifest.version === version);
}

export type ConnectWorkflowOptions = { replaceBinding?: boolean };

// 只识别会落到数据输入端口的连接。控制连线不读取 inputs。
export function staticBindingForDataConnection(
  definition: WorkflowDefinition,
  connection: {
    target?: string | null;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  },
): StaticInputBinding | undefined {
  try {
    const source = parseWorkflowHandle(connection.sourceHandle, 'source');
    const target = parseWorkflowHandle(connection.targetHandle, 'target');
    if (source.kind !== 'data' || target.kind !== 'data' || !connection.target) return undefined;
    return definition.nodes.find((node) => node.id === connection.target)?.inputs[target.portKey];
  } catch (error) {
    if (error instanceof z.ZodError) return undefined;
    throw error;
  }
}

function addWorkflowEdge(
  workflow: WorkflowDefinition,
  connection: WorkflowConnection,
  manifests: readonly NodeTypeManifest[],
  id: string,
  expectedKind?: WorkflowEdgeDefinition['kind'],
  options?: ConnectWorkflowOptions,
): WorkflowDefinition {
  const sourceHandle = parseWorkflowHandle(connection.sourceHandle, 'source');
  const targetHandle = parseWorkflowHandle(connection.targetHandle, 'target');
  if (sourceHandle.kind !== targetHandle.kind) {
    throw new Error('数据端口与控制端口不能混连');
  }
  if (expectedKind !== undefined && sourceHandle.kind !== expectedKind) {
    throw new Error('重连不能改变边类型');
  }
  const source = workflow.nodes.find((node) => node.id === connection.source);
  if (!source) throw new Error('连线的来源节点不存在');
  const target = workflow.nodes.find((node) => node.id === connection.target);
  if (!target) throw new Error('连线的目标节点不存在');
  if (source.id === target.id) throw new Error('边不能连接自身');
  const sourceManifest = manifestFor(manifests, source.type, source.typeVersion);
  const targetManifest = manifestFor(manifests, target.type, target.typeVersion);
  if (!sourceManifest || !targetManifest) throw new Error('节点类型不可用');
  if (sourceHandle.kind === 'control' && targetHandle.kind === 'control') {
    if (
      targetHandle.portKey !== undefined ||
      (sourceHandle.portKey !== undefined &&
        !sourceManifest.controlOutputs?.some((port) => port.key === sourceHandle.portKey))
    ) {
      throw new Error('命名控制端口尚未声明');
    }
    if (sourceManifest.controlOutputs?.length && sourceHandle.portKey === undefined)
      throw new Error('请选择已声明的控制出口');
    if (
      source.type === 'flow.if' &&
      source.typeVersion === 1 &&
      sourceManifest.executionKind === 'control'
    ) {
      const routes = workflow.edges.filter(
        (edge) => edge.kind === 'control' && edge.source.nodeId === source.id,
      );
      if (routes.some((edge) => edge.source.portKey === sourceHandle.portKey))
        throw new Error('该条件出口已连接，请先断开或重连');
      if (routes.some((edge) => edge.target.nodeId === target.id))
        throw new Error('true / false 不能连接同一目标');
    }
    workflow.edges.push({
      id,
      kind: 'control',
      source: {
        nodeId: source.id,
        ...(sourceHandle.portKey === undefined ? {} : { portKey: sourceHandle.portKey }),
      },
      target: { nodeId: target.id },
    });
    return workflowDraftDefinitionSchema.parse(workflow);
  }
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
        edge.kind === 'data' &&
        edge.target.nodeId === connection.target &&
        edge.target.portKey === connection.targetHandle,
    )
  ) {
    throw new Error('目标输入端口已经存在连接');
  }
  // 一个数据输入只有一个来源。已有静态绑定时必须由调用方明确确认，才能改由 Data Edge 提供。
  const binding = target.inputs[connection.targetHandle];
  if (binding && !options?.replaceBinding) {
    throw new Error('目标输入已有内容，连接前需要确认替换');
  }
  if (binding) delete target.inputs[connection.targetHandle];
  workflow.edges.push({
    id,
    kind: 'data',
    source: { nodeId: connection.source, portKey: connection.sourceHandle },
    target: { nodeId: connection.target, portKey: connection.targetHandle },
  });
  return workflowDraftDefinitionSchema.parse(workflow);
}

export function connectWorkflowNodes(
  input: unknown,
  connectionInput: unknown,
  manifestsInput: unknown,
  options?: ConnectWorkflowOptions,
): WorkflowDefinition {
  return addWorkflowEdge(
    workflowDraftDefinitionSchema.parse(input),
    connectionSchema.parse(connectionInput),
    nodeTypeManifestListSchema.parse(manifestsInput),
    `edge_${globalThis.crypto.randomUUID()}`,
    undefined,
    options,
  );
}

function matchesWorkflowEdge(edge: WorkflowEdgeDefinition, snapshot: WorkflowEdgeDefinition) {
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
  const workflow = workflowDraftDefinitionSchema.parse(input);
  const snapshot = fromReactFlowEdge(edgeInput);
  workflow.edges = workflow.edges.filter((edge) => !matchesWorkflowEdge(edge, snapshot));
  return workflow;
}

// 重连先移除匹配的旧边再统一校验；失败不修改调用方，成功保留领域边 ID。
export function reconnectWorkflowEdge(
  input: unknown,
  edgeInput: unknown,
  connectionInput: unknown,
  manifestsInput: unknown,
  options?: ConnectWorkflowOptions,
): WorkflowDefinition {
  const workflow = workflowDraftDefinitionSchema.parse(input);
  const snapshot = fromReactFlowEdge(edgeInput);
  const index = workflow.edges.findIndex((edge) => matchesWorkflowEdge(edge, snapshot));
  if (index === -1) return workflow;
  workflow.edges.splice(index, 1);
  return addWorkflowEdge(
    workflow,
    connectionSchema.parse(connectionInput),
    nodeTypeManifestListSchema.parse(manifestsInput),
    snapshot.id,
    snapshot.kind,
    options,
  );
}
