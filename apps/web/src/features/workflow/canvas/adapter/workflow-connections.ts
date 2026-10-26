import {
  isTypeAssignable,
  nodeTypeManifestListSchema,
  workflowDraftDefinitionSchema,
  type WorkflowEdge as WorkflowEdgeDefinition,
  type NodeTypeManifest,
  type StaticInputBinding,
  type CandidateBinding,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { z } from 'zod';
import { resolveWorkflowNodePorts } from '../../ports/resolve-workflow-node-ports';
import { parseWorkflowHandle } from './workflow-handles';
import {
  connectionSchema,
  reactFlowEdgeSchema,
  fromReactFlowEdge,
  type WorkflowConnection,
} from './edge-adapter';

function manifestFor(manifests: readonly NodeTypeManifest[], type: string, version: number) {
  return manifests.find((manifest) => manifest.type === type && manifest.version === version);
}

export type ConnectWorkflowOptions = { replaceBinding?: boolean; addCandidate?: boolean };

// 仅识别整个输入的节点输出来源，不把 Template variables 当成候选输入。
export function sourcesForDataConnection(
  definition: WorkflowDefinition,
  connection: Parameters<typeof staticBindingForDataConnection>[1],
): CandidateBinding['sources'] {
  const binding = staticBindingForDataConnection(definition, connection);
  if (binding?.type === 'candidate') return binding.sources;
  if (
    parseWorkflowHandle(connection.sourceHandle, 'source').kind !== 'data' ||
    parseWorkflowHandle(connection.targetHandle, 'target').kind !== 'data'
  )
    return [];
  return definition.edges.flatMap((edge) =>
    edge.kind === 'data' &&
    edge.target.nodeId === connection.target &&
    edge.target.portKey === connection.targetHandle
      ? [{ type: 'node_output' as const, ...edge.source }]
      : [],
  );
}

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
  const output = resolveWorkflowNodePorts(source, sourceManifest).outputs.find(
    (port) => port.key === connection.sourceHandle,
  );
  if (!output) throw new Error('来源端口不存在');
  const inputPort = resolveWorkflowNodePorts(target, targetManifest).inputs.find(
    (port) => port.key === connection.targetHandle,
  );
  if (!inputPort) throw new Error('目标端口不存在');
  if (!isTypeAssignable(output.dataType, inputPort.dataType)) {
    throw new Error('端口类型不兼容');
  }
  const sources = sourcesForDataConnection(workflow, connection);
  const binding = target.inputs[connection.targetHandle];
  if (
    (binding?.type === 'candidate' || options?.addCandidate || options?.replaceBinding) &&
    sources.some((item) => item.nodeId === source.id && item.portKey === output.key)
  )
    return workflow;
  if (options?.addCandidate) {
    if (sources.length >= 2) throw new Error('当前候选输入最多支持两个来源，请先删除一个来源');
    if (binding && binding.type !== 'candidate')
      throw new Error('当前输入内容不能直接添加为候选来源');
    target.inputs[connection.targetHandle] = {
      type: 'candidate',
      sources: [...sources, { type: 'node_output', nodeId: source.id, portKey: output.key }],
    };
    workflow.edges = workflow.edges.filter(
      (edge) =>
        !(
          edge.kind === 'data' &&
          edge.target.nodeId === target.id &&
          edge.target.portKey === connection.targetHandle
        ),
    );
    return workflowDraftDefinitionSchema.parse(workflow);
  }
  if (sources.length && !options?.replaceBinding)
    throw new Error('目标输入端口已经存在连接，连接前需要确认替换');
  if (binding && !options?.replaceBinding) throw new Error('目标输入已有内容，连接前需要确认替换');
  if (binding) delete target.inputs[connection.targetHandle];
  workflow.edges = workflow.edges.filter(
    (edge) =>
      !(
        edge.kind === 'data' &&
        edge.target.nodeId === target.id &&
        edge.target.portKey === connection.targetHandle
      ),
  );
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
  const projection = reactFlowEdgeSchema.parse(edgeInput);
  // Template 只通过输入编辑器修改；删线事件不隐式删除正文或 alias。
  if (projection.data.projection === 'template-input') return workflow;
  if (projection.data.projection === 'workflow-input') {
    const node = workflow.nodes.find((item) => item.id === projection.target);
    const key = projection.targetHandle;
    const binding = key ? node?.inputs[key] : undefined;
    if (
      node &&
      key &&
      binding?.type === 'workflow_input' &&
      binding.key === projection.sourceHandle
    ) {
      delete node.inputs[key];
    }
    return workflow;
  }
  if (projection.data.projection === 'candidate-input') {
    const node = workflow.nodes.find((node) => node.id === projection.target);
    const key = projection.targetHandle;
    const binding = key ? node?.inputs[key] : undefined;
    // 仅清理仍存在的候选端点；旧投影不能删除随后创建的普通 DataEdge。
    if (node && key && binding?.type === 'candidate') {
      const remaining = binding.sources.filter(
        (source) =>
          source.nodeId !== projection.source || source.portKey !== projection.sourceHandle,
      );
      if (remaining.length) node.inputs[key] = { type: 'candidate', sources: remaining };
      else delete node.inputs[key];
    }
    return workflow;
  }
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
