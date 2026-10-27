import {
  graphDefinitionSchema,
  nestedGraphSlots,
  type GraphDefinition,
} from '@dramaflow/contracts';
import type { NodeRegistry } from '../../node/registry/registry.js';
import { WorkflowPublishValidationError, invalid } from './publish-issue.js';
import type { GraphValidationContext, ValidatedDefinitionNode } from './types.js';
import { NodeSemanticsValidator } from './semantics/node-semantics.js';
import { validateEdgeSemantics } from './semantics/edge-semantics.js';
import { validateInputSemantics } from './semantics/input-semantics.js';
import { validateOutputSemantics } from './semantics/output-semantics.js';

export { WorkflowPublishValidationError, type WorkflowPublishIssueCode } from './publish-issue.js';
export type {
  GraphValidationContext,
  ValidatedDefinitionNode,
  ValidatedPublishNode,
} from './types.js';

// 正式 Definition Schema 统一校验引用、来源冲突和联合 DAG。
// 这里只检查 Registry / Schema 静态语义，不代表允许生产发布；执行能力门禁由 Compiler 负责。
// 资源归属仍由应用层在发布事务内检查。
export function validateGraphDefinitionSemantics(
  definition: GraphDefinition,
  registry: NodeRegistry,
  context: GraphValidationContext = { definitionPath: [], capability: 'workflow' },
): ValidatedDefinitionNode[] {
  definition = graphDefinitionSchema.parse(definition);
  const { definitionPath } = context;
  const descendants: ValidatedDefinitionNode[] = [];
  const validator = new NodeSemanticsValidator(registry);
  const entries = definition.nodes.map((node): ValidatedDefinitionNode => {
    const entry = validator.validate(node, definitionPath);
    for (const slot of nestedGraphSlots(node)) {
      if (slot.graphKey === 'body' && slot.graph.nodes.length === 0)
        invalid('ITERATION_BODY_EMPTY', node.id);
      const childPath = [...definitionPath, { nodeId: node.id, graphKey: slot.graphKey }];
      try {
        descendants.push(
          ...validateGraphDefinitionSemantics(slot.graph, registry, {
            definitionPath: childPath,
            capability: 'workflow',
          }),
        );
      } catch (error) {
        if (error instanceof WorkflowPublishValidationError && !error.definitionPath)
          throw new WorkflowPublishValidationError(
            error.code,
            error.nodeId,
            error.portKey,
            childPath,
          );
        throw error;
      }
    }
    return entry;
  });
  const nodes = new Map(entries.map((entry) => [entry.node.id, entry]));
  validateEdgeSemantics(definition, nodes, entries);
  validateInputSemantics(definition, nodes, entries);
  validateOutputSemantics(definition, nodes);
  return [...entries, ...descendants];
}
