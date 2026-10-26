import type { GraphDefinition } from './definition.js';
import type { NodeDefinition } from '../node/definition.js';

// 静态定义路径，不包含 execution identity、scope 或 checkpoint namespace。
export type GraphDefinitionPath = readonly {
  readonly nodeId: string;
  readonly graphKey: 'body' | 'graph';
}[];
export interface NestedGraphSlot {
  readonly graphKey: 'body' | 'graph';
  readonly graph: GraphDefinition;
}
export function nestedGraphSlots(
  node: Pick<NodeDefinition, 'composite'>,
): readonly NestedGraphSlot[] {
  const composite = node.composite;
  if (!composite) return [];
  switch (composite.kind) {
    case 'iteration':
      return [{ graphKey: 'body', graph: composite.body }];
    case 'subworkflow':
      return [{ graphKey: 'graph', graph: composite.graph }];
  }
}
export function* walkGraphDefinitions(
  graph: GraphDefinition,
  path: GraphDefinitionPath = [],
): Generator<{ graph: GraphDefinition; path: GraphDefinitionPath }> {
  yield { graph, path };
  for (const node of graph.nodes)
    for (const slot of nestedGraphSlots(node))
      yield* walkGraphDefinitions(slot.graph, [
        ...path,
        { nodeId: node.id, graphKey: slot.graphKey },
      ]);
}
