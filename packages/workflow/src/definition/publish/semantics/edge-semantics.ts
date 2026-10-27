import { isTypeAssignable, type GraphDefinition } from '@dramaflow/contracts';
import { invalid } from '../publish-issue.js';
import type { ValidatedDefinitionNode } from '../types.js';
import { isSupportedIf } from './node-semantics.js';

export function validateEdgeSemantics(
  definition: GraphDefinition,
  nodes: ReadonlyMap<string, ValidatedDefinitionNode>,
  entries: readonly ValidatedDefinitionNode[],
): void {
  for (const edge of definition.edges) {
    if (edge.kind === 'control') {
      const source = nodes.get(edge.source.nodeId)!;
      // 当前仅声明控制出口；目标命名控制输入没有对应协议，不放行。
      if (edge.target.portKey !== undefined)
        invalid('NAMED_CONTROL_PORT_UNSUPPORTED', edge.target.nodeId, edge.target.portKey);
      if (edge.source.portKey !== undefined) {
        if (
          !source.nodeType.manifest.controlOutputs?.some((port) => port.key === edge.source.portKey)
        )
          invalid('NAMED_CONTROL_PORT_UNSUPPORTED', source.node.id, edge.source.portKey);
      } else if (isSupportedIf(source.nodeType)) {
        invalid('CONTROL_OUTPUT_PORT_REQUIRED', source.node.id);
      }
      continue;
    }
    const source = nodes.get(edge.source.nodeId)!;
    const target = nodes.get(edge.target.nodeId)!;
    const output = source.ports.outputs.find((port) => port.key === edge.source.portKey);
    const input = target.ports.inputs.find((port) => port.key === edge.target.portKey);
    if (!output) invalid('OUTPUT_PORT_NOT_FOUND', source.node.id, edge.source.portKey);
    if (!input) invalid('INPUT_PORT_NOT_FOUND', target.node.id, edge.target.portKey);
    if (!isTypeAssignable(output.dataType, input.dataType))
      invalid('INPUT_TYPE_MISMATCH', target.node.id, input.key);
  }

  for (const { node, nodeType } of entries) {
    if (!isSupportedIf(nodeType)) continue;
    for (const branch of ['true', 'false']) {
      if (
        !definition.edges.some(
          (edge) =>
            edge.kind === 'control' &&
            edge.source.nodeId === node.id &&
            edge.source.portKey === branch,
        )
      )
        invalid('CONTROL_OUTPUT_BRANCH_MISSING', node.id, branch);
    }
  }
}
