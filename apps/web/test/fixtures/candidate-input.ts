import { workflowDraftDefinitionSchema, type WorkflowDefinition } from '@dramaflow/contracts';
import { ifWorkflow } from './workflow-if';

export const candidateConnection = {
  source: 'b',
  sourceHandle: 'text',
  target: 'c',
  targetHandle: 'prompt',
};
export function candidateWorkflow(): WorkflowDefinition {
  const workflow = ifWorkflow();
  workflow.nodes[3]!.inputs.prompt = {
    type: 'candidate',
    sources: [
      { type: 'node_output', nodeId: 'a', portKey: 'text' },
      { type: 'node_output', nodeId: 'b', portKey: 'text' },
    ],
  };
  workflow.edges = [
    {
      id: 'yes',
      kind: 'control',
      source: { nodeId: 'if', portKey: 'true' },
      target: { nodeId: 'a' },
    },
    {
      id: 'no',
      kind: 'control',
      source: { nodeId: 'if', portKey: 'false' },
      target: { nodeId: 'b' },
    },
  ];
  return workflowDraftDefinitionSchema.parse(workflow);
}
