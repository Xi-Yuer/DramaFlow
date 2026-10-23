import { workflowDraftDefinitionSchema, type WorkflowDefinition } from '@dramaflow/contracts';
import { manifest } from './workflow-output';
import { createWorkflowNode } from '../../src/features/workflow/node-catalog/create-workflow-node';

export const templateManifest = {
  ...manifest,
  type: 'ai.text_generate',
  inputs: [...manifest.inputs, { ...manifest.inputs[0]!, key: 'system', name: '系统提示词' }],
  outputs: [
    { ...manifest.outputs[0]!, name: '生成文本' },
    { ...manifest.outputs[0]!, key: 'other', name: '其他文本' },
  ],
};
export function templateWorkflow(): WorkflowDefinition {
  const nodes = ['a', 'b', 'c'].map((id) =>
    createWorkflowNode(templateManifest, id, id, { x: 0, y: 0 }),
  );
  nodes[2]!.inputs.prompt = {
    type: 'template',
    value: '根据 {{outline}} {{characters}} 继续',
    variables: {
      outline: { type: 'node_output', nodeId: 'a', portKey: 'text' },
      characters: { type: 'node_output', nodeId: 'b', portKey: 'text' },
    },
  };
  return workflowDraftDefinitionSchema.parse({ inputs: [], nodes, edges: [], outputs: [] });
}
