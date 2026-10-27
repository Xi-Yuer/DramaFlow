import {
  isTypeAssignable,
  workflowOutputSources,
  type GraphDefinition,
} from '@dramaflow/contracts';
import { invalid } from '../publish-issue.js';
import type { ValidatedDefinitionNode } from '../types.js';

export function validateOutputSemantics(
  definition: GraphDefinition,
  nodes: ReadonlyMap<string, ValidatedDefinitionNode>,
): void {
  for (const output of definition.outputs) {
    for (const candidate of workflowOutputSources(output)) {
      const source = nodes.get(candidate.nodeId)!;
      const port = source.ports.outputs.find((port) => port.key === candidate.outputKey);
      if (!port) invalid('OUTPUT_PORT_NOT_FOUND', source.node.id, candidate.outputKey);
      if (!isTypeAssignable(port.dataType, output.type))
        invalid('WORKFLOW_OUTPUT_TYPE_MISMATCH', source.node.id, candidate.outputKey);
    }
  }
}
