import type { GraphDefinitionPath, NodeDefinition, ResolvedNodePorts } from '@dramaflow/contracts';
import type { NodeDeclaration } from '../../node/registry/type.js';

export interface ValidatedDefinitionNode {
  readonly node: NodeDefinition;
  readonly nodeType: NodeDeclaration;
  readonly config: unknown;
  readonly ports: ResolvedNodePorts;
  readonly definitionPath?: GraphDefinitionPath;
}

export type ValidatedPublishNode = ValidatedDefinitionNode;

export interface GraphValidationContext {
  readonly definitionPath: GraphDefinitionPath;
  readonly capability: 'workflow' | 'iteration_body_v1' | 'subworkflow_graph_v1';
}
