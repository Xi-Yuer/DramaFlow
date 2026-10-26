import {
  StringType,
  iterationCompositeDefinitionSchema,
  type DataType,
  type IterationCompositeDefinition,
  type NodeDefinition,
} from '@dramaflow/contracts';
import { fail } from '../../inputs/definitions/input-validation';

export const ITERATION_ITEMS_KEY = 'items';

function parseComposite(composite: IterationCompositeDefinition) {
  const parsed = iterationCompositeDefinitionSchema.safeParse(composite);
  if (!parsed.success) fail(parsed.error, 'Iteration 定义无效');
  return parsed.data;
}

export function withComposite(
  node: NodeDefinition,
  composite: IterationCompositeDefinition,
): NodeDefinition {
  return { ...node, composite: parseComposite(composite) };
}

export function createEmptyIterationComposite(
  itemType: DataType = StringType,
): IterationCompositeDefinition {
  return parseComposite({
    kind: 'iteration',
    itemType,
    invariantInputs: [],
    bodyInputMapping: [],
    body: { inputs: [], nodes: [], edges: [], outputs: [] },
  });
}

export function initializeIterationBody(node: NodeDefinition): NodeDefinition {
  if (node.composite?.kind === 'iteration') return node;
  return withComposite(node, createEmptyIterationComposite());
}

export function requireComposite(node: NodeDefinition) {
  if (node.composite?.kind !== 'iteration') throw new Error('Iteration 尚未初始化 Body');
  return node.composite;
}
