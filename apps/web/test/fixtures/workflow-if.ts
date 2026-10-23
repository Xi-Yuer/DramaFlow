import type { NodeTypeManifest, WorkflowDefinition } from '@dramaflow/contracts';
import { createWorkflowNode } from '../../src/features/workflow/node-catalog/create-workflow-node';
import { manifest as actionManifest } from './workflow-output';

export const ifManifest: NodeTypeManifest = {
  type: 'flow.if',
  version: 1,
  executionKind: 'control',
  metadata: { name: '条件分支', category: 'flow' },
  inputs: [
    {
      key: 'value',
      name: '输入值',
      dataType: { kind: 'primitive', name: 'string' },
      required: true,
    },
  ],
  outputs: [],
  controlOutputs: [
    { key: 'true', name: '条件成立' },
    { key: 'false', name: '条件不成立' },
  ],
  config: [{ key: 'condition', name: '条件', type: 'condition', required: true }],
};
export const ifCatalog = [ifManifest, actionManifest];
export function ifWorkflow(): WorkflowDefinition {
  return {
    inputs: [],
    outputs: [],
    edges: [],
    nodes: [
      createWorkflowNode(ifManifest, 'if', '条件分支', { x: 0, y: 0 }),
      ...['a', 'b', 'c'].map((id) => createWorkflowNode(actionManifest, id, id, { x: 0, y: 0 })),
    ],
  };
}
