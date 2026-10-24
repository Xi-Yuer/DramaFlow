import {
  workflowDraftDefinitionSchema,
  workflowPortNameSchema,
  workflowOutputSources,
  isTypeAssignable,
  type NodeTypeManifest,
  type WorkflowDefinition,
  type WorkflowOutputSource,
} from '@dramaflow/contracts';
import type { Edge, Node, XYPosition } from '@xyflow/react';
import { removeTemplateNodeSources } from '../inputs/template-input';
import { findResolvedNodePorts } from '../ports/resolve-workflow-node-ports';

export const END_INPUT_HANDLE = 'workflow-output';
export type WorkflowOutputEdge = Edge<{ kind: 'workflow-output'; outputName: string }>;
export type WorkflowOutputEdit =
  | { name: string; source: WorkflowOutputSource; sources?: never }
  | { name: string; source?: never; sources: readonly WorkflowOutputSource[] };
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
  const edges: WorkflowOutputEdge[] = definition.outputs.flatMap((output) =>
    workflowOutputSources(output).map((source) => ({
      id: unusedId(
        `ui:workflow-output:${JSON.stringify([output.name, source.nodeId, source.outputKey])}`,
        usedEdges,
      ),
      source: source.nodeId,
      sourceHandle: source.outputKey,
      target: id,
      targetHandle: END_INPUT_HANDLE,
      label: output.name,
      data: { kind: 'workflow-output', outputName: output.name },
      reconnectable: false,
    })),
  );
  return { node, edges };
}

export function setWorkflowOutput(
  definition: WorkflowDefinition,
  value: WorkflowOutputEdit,
  manifests: readonly NodeTypeManifest[],
  previousName?: string,
): WorkflowDefinition {
  workflowPortNameSchema.parse(value.name);
  if (
    definition.outputs.some((output) => output.name === value.name && output.name !== previousName)
  ) {
    throw new Error('工作流输出名称不能重复');
  }
  const ports = workflowOutputSources(value).map((source) => {
    const node = definition.nodes.find((node) => node.id === source.nodeId);
    const port = findResolvedNodePorts(node, manifests)?.outputs.find(
      (port) => port.key === source.outputKey,
    );
    if (!port) throw new Error('请选择可用的来源节点和输出端口');
    return port;
  });
  const type =
    value.sources === undefined
      ? ports[0]?.dataType
      : (definition.outputs.find((output) => output.name === previousName)?.type ??
        ports[0]?.dataType);
  if (!type) throw new Error('请先选择输出来源以确定类型');
  if (ports.some((port) => !isTypeAssignable(port.dataType, type)))
    throw new Error('候选来源与工作流输出类型不兼容');
  if (
    previousName !== undefined &&
    !definition.outputs.some((output) => output.name === previousName)
  ) {
    throw new Error('该工作流输出已被删除，请重新打开配置');
  }
  const output =
    value.sources === undefined
      ? { name: value.name, source: value.source, type }
      : { name: value.name, sources: [...value.sources], type };
  return workflowDraftDefinitionSchema.parse({
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

export function appendWorkflowOutputCandidate(
  definition: WorkflowDefinition,
  name: string,
  source: WorkflowOutputSource,
  manifests: readonly NodeTypeManifest[],
): WorkflowDefinition {
  const output = definition.outputs.find((output) => output.name === name);
  if (!output) throw new Error('该工作流输出已被删除');
  const node = definition.nodes.find((node) => node.id === source.nodeId);
  const port = findResolvedNodePorts(node, manifests)?.outputs.find(
    (port) => port.key === source.outputKey,
  );
  if (!port) throw new Error('请选择可用的来源节点和输出端口');
  if (!isTypeAssignable(port.dataType, output.type))
    throw new Error('候选来源与工作流输出类型不兼容');
  return workflowDraftDefinitionSchema.parse({
    ...definition,
    outputs: definition.outputs.map((item) =>
      item.name === name
        ? { name: item.name, type: item.type, sources: [...workflowOutputSources(item), source] }
        : item,
    ),
  });
}

export function removeWorkflowOutputCandidate(
  definition: WorkflowDefinition,
  name: string,
  source: WorkflowOutputSource,
): WorkflowDefinition {
  return {
    ...definition,
    outputs: definition.outputs.flatMap<WorkflowDefinition['outputs'][number]>((output) => {
      if (output.name !== name) return [output];
      const remaining = workflowOutputSources(output).filter(
        (candidate) =>
          candidate.nodeId !== source.nodeId || candidate.outputKey !== source.outputKey,
      );
      // 单来源维持原删除行为；候选模式始终保留，允许空候选 Draft 修复。
      if (output.sources === undefined) return remaining.length ? [output] : [];
      return [{ ...output, sources: remaining }];
    }),
  };
}

// 删除节点时同步清除关联连线、输入引用与 Workflow outputs，避免保存悬空引用。
export function removeWorkflowNodes(
  definition: WorkflowDefinition,
  ids: readonly string[],
): WorkflowDefinition {
  const removed = new Set(ids);
  return workflowDraftDefinitionSchema.parse({
    ...definition,
    nodes: definition.nodes
      .filter((node) => !removed.has(node.id))
      .map((node) => {
        const inputs = { ...node.inputs };
        for (const [key, binding] of Object.entries(inputs)) {
          if (binding.type === 'template') {
            const remaining = removeTemplateNodeSources(binding, removed);
            if (remaining) inputs[key] = remaining;
            else delete inputs[key];
            continue;
          }
          if (
            binding.type !== 'candidate' ||
            !binding.sources.some((source) => removed.has(source.nodeId))
          )
            continue;
          const sources = binding.sources.filter((source) => !removed.has(source.nodeId));
          if (sources.length) inputs[key] = { type: 'candidate', sources };
          else delete inputs[key];
        }
        return { ...node, inputs };
      }),
    edges: definition.edges.filter(
      (edge) => !removed.has(edge.source.nodeId) && !removed.has(edge.target.nodeId),
    ),
    outputs: definition.outputs.flatMap<WorkflowDefinition['outputs'][number]>((output) =>
      output.sources === undefined
        ? removed.has(output.source.nodeId)
          ? []
          : [output]
        : [{ ...output, sources: output.sources.filter((source) => !removed.has(source.nodeId)) }],
    ),
  });
}
