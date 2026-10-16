import type { NodeDefinition, WorkflowDefinition, WorkflowNode } from '@dramaflow/contracts';

/** 收集与汇合节点允许命名输入；收集节点按名称透传给后续节点。 */
export function resolveNodeDefinition(
  node: WorkflowNode,
  catalog: NodeDefinition[],
  workflow: WorkflowDefinition,
): NodeDefinition | undefined {
  const definition = catalog.find(
    (entry) => entry.type === node.type && entry.version === node.version,
  );
  if (!definition || (node.type !== 'output' && node.type !== 'merge')) return definition;
  const names = workflow.bindings
    .filter((binding) => binding.nodeId === node.id)
    .map((binding) => binding.port);
  const dynamic = names
    .filter((name) => !definition.inputs.some((port) => port.name === name))
    .map((name) => ({ name, label: name, dataType: 'any' as const }));
  const outputs =
    node.type === 'output'
      ? [
          ...definition.outputs,
          ...dynamic.filter(
            (port) => !definition.outputs.some((output) => output.name === port.name),
          ),
        ]
      : definition.outputs;
  return { ...definition, inputs: [...definition.inputs, ...dynamic], outputs };
}
