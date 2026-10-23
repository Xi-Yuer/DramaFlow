import {
  workflowDefinitionSchema,
  workflowPortNameSchema,
  type NodeTypeManifest,
  type WorkflowDefinition,
  type WorkflowOutputSource,
} from '@dramaflow/contracts';
import type { Edge, Node, XYPosition } from '@xyflow/react';

export const END_INPUT_HANDLE = 'workflow-output';
export type WorkflowOutputEdge = Edge<{ kind: 'workflow-output'; outputName: string }>;
export type WorkflowEndNode = Node<
  {
    outputs: WorkflowDefinition['outputs'];
  },
  'workflowEnd'
>;

function unusedId(base: string, used: ReadonlySet<string>) {
  let id = base;
  while (used.has(id)) id += '_';
  return id;
}

// 只生成视图元素；结束边界及其连线永不写入领域 nodes / edges。
export function projectWorkflowEnd(definition: WorkflowDefinition, position?: XYPosition) {
  const id = unusedId('ui:workflow-end', new Set(definition.nodes.map((node) => node.id)));
  const node: WorkflowEndNode = {
    id,
    type: 'workflowEnd',
    deletable: false,
    position: position ?? {
      x: definition.nodes.length
        ? Math.max(...definition.nodes.map((node) => node.ui.position.x)) + 420
        : 480,
      y: definition.nodes.length
        ? Math.min(...definition.nodes.map((node) => node.ui.position.y))
        : 160,
    },
    data: { outputs: definition.outputs },
  };
  const usedEdges = new Set(definition.edges.map((edge) => edge.id));
  const edges: WorkflowOutputEdge[] = definition.outputs.map((output) => ({
    id: unusedId(`ui:workflow-output:${output.name}`, usedEdges),
    source: output.source.nodeId,
    sourceHandle: output.source.outputKey,
    target: id,
    targetHandle: END_INPUT_HANDLE,
    label: output.name,
    data: { kind: 'workflow-output', outputName: output.name },
    reconnectable: false,
  }));
  return { node, edges };
}

export function setWorkflowOutput(
  definition: WorkflowDefinition,
  value: { name: string; source: WorkflowOutputSource },
  manifests: readonly NodeTypeManifest[],
  previousName?: string,
): WorkflowDefinition {
  workflowPortNameSchema.parse(value.name);
  if (
    definition.outputs.some((output) => output.name === value.name && output.name !== previousName)
  ) {
    throw new Error('工作流输出名称不能重复');
  }
  const node = definition.nodes.find((node) => node.id === value.source.nodeId);
  const manifest = manifests.find(
    (manifest) => manifest.type === node?.type && manifest.version === node.typeVersion,
  );
  const port = manifest?.outputs.find((port) => port.key === value.source.outputKey);
  if (!node || !port) throw new Error('请选择可用的来源节点和输出端口');
  if (
    previousName !== undefined &&
    !definition.outputs.some((output) => output.name === previousName)
  ) {
    throw new Error('该工作流输出已被删除，请重新打开配置');
  }
  const output = { name: value.name, source: value.source, type: port.dataType };
  return workflowDefinitionSchema.parse({
    ...definition,
    outputs:
      previousName === undefined
        ? [...definition.outputs, output]
        : definition.outputs.map((current) => (current.name === previousName ? output : current)),
  });
}

export function addWorkflowOutput(
  definition: WorkflowDefinition,
  source: WorkflowOutputSource,
  manifests: readonly NodeTypeManifest[],
) {
  return setWorkflowOutput(
    definition,
    { name: nextWorkflowOutputName(definition), source },
    manifests,
  );
}

export function nextWorkflowOutputName(definition: WorkflowDefinition): string {
  let name = 'result';
  for (let suffix = 2; definition.outputs.some((output) => output.name === name); suffix++)
    name = `result_${suffix}`;
  return name;
}

export function removeWorkflowOutput(
  definition: WorkflowDefinition,
  name: string,
): WorkflowDefinition {
  return { ...definition, outputs: definition.outputs.filter((output) => output.name !== name) };
}

// 删除节点时同步清除关联连线与 Workflow outputs，避免保存悬空输出。
export function removeWorkflowNodes(
  definition: WorkflowDefinition,
  ids: readonly string[],
): WorkflowDefinition {
  const removed = new Set(ids);
  return workflowDefinitionSchema.parse({
    ...definition,
    nodes: definition.nodes.filter((node) => !removed.has(node.id)),
    edges: definition.edges.filter(
      (edge) => !removed.has(edge.source.nodeId) && !removed.has(edge.target.nodeId),
    ),
    outputs: definition.outputs.filter((output) => !removed.has(output.source.nodeId)),
  });
}
