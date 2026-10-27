import {
  isTypeAssignable,
  workflowDraftDefinitionSchema,
  type DataType,
  type NodeTypeManifest,
  type StaticInputBinding,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { removeVariable, replaceNodeInput } from '../template/binding';
import { resolveWorkflowNodePorts } from '../../ports/resolve-workflow-node-ports';

function rewriteBinding(
  binding: StaticInputBinding,
  from: string,
  to: string | null,
): StaticInputBinding | null {
  if (binding.type === 'workflow_input') {
    if (binding.key !== from) return binding;
    return to ? { type: 'workflow_input', key: to } : null;
  }
  if (binding.type !== 'template') return binding;
  let value = binding.value;
  const variables = { ...binding.variables };
  let changed = false;
  for (const [alias, source] of Object.entries(variables)) {
    if (source.type !== 'workflow_input' || source.key !== from) continue;
    changed = true;
    if (to) variables[alias] = { type: 'workflow_input', key: to };
    else {
      delete variables[alias];
      value = removeVariable(value, alias);
    }
  }
  if (!changed) return binding;
  if (Object.keys(variables).length === 0) {
    const trimmed = value.trim();
    return trimmed ? { type: 'constant', value: trimmed } : null;
  }
  return { type: 'template', value, variables };
}

export function rewriteGraphBindings(graph: WorkflowDefinition, from: string, to: string | null) {
  return graph.nodes.map((node) => {
    let changed = false;
    const inputs = { ...node.inputs };
    for (const [key, binding] of Object.entries(inputs)) {
      const next = rewriteBinding(binding, from, to);
      if (next === binding) continue;
      changed = true;
      if (next) inputs[key] = next;
      else delete inputs[key];
    }
    return changed ? { ...node, inputs } : node;
  });
}

export function clearIncompatibleBindings(
  graph: WorkflowDefinition,
  inputName: string,
  inputType: DataType,
  manifests: readonly NodeTypeManifest[],
) {
  return graph.nodes.map((node) => {
    const manifest = manifests.find(
      (item) => item.type === node.type && item.version === node.typeVersion,
    );
    if (!manifest) return node;
    const ports = resolveWorkflowNodePorts(node, manifest);
    let changed = false;
    const inputs = { ...node.inputs };
    for (const [key, binding] of Object.entries(inputs)) {
      if (binding.type !== 'workflow_input' || binding.key !== inputName) continue;
      const port = ports.inputs.find((item) => item.key === key);
      if (port && isTypeAssignable(inputType, port.dataType)) continue;
      delete inputs[key];
      changed = true;
    }
    return changed ? { ...node, inputs } : node;
  });
}

export function bindGraphInput(
  definition: WorkflowDefinition,
  manifests: readonly NodeTypeManifest[],
  targetNodeId: string,
  portKey: string,
  inputKey: string,
): WorkflowDefinition {
  const input = definition.inputs.find((item) => item.name === inputKey);
  if (!input) throw new Error('图输入不存在');
  const node = definition.nodes.find((item) => item.id === targetNodeId);
  if (!node) throw new Error('目标节点不存在');
  const manifest = manifests.find(
    (item) => item.type === node.type && item.version === node.typeVersion,
  );
  if (!manifest) throw new Error('节点类型不可用');
  const port = resolveWorkflowNodePorts(node, manifest).inputs.find((item) => item.key === portKey);
  if (!port) throw new Error('目标端口不存在');
  if (!isTypeAssignable(input.type, port.dataType)) throw new Error('端口类型不兼容');
  const existing = node.inputs[portKey];
  const blockingEdge = definition.edges.some(
    (edge) =>
      edge.kind === 'data' &&
      edge.target.nodeId === targetNodeId &&
      edge.target.portKey === portKey,
  );
  if (existing?.type === 'workflow_input' && existing.key === inputKey && !blockingEdge) {
    return definition;
  }
  const replaced = replaceNodeInput(definition, targetNodeId, portKey, {
    type: 'workflow_input',
    key: inputKey,
  });
  return workflowDraftDefinitionSchema.parse({
    ...replaced,
    edges: replaced.edges.filter(
      (edge) =>
        !(
          edge.kind === 'data' &&
          edge.target.nodeId === targetNodeId &&
          edge.target.portKey === portKey
        ),
    ),
  });
}
