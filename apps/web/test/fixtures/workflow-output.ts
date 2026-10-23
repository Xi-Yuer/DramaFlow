import type { NodeTypeManifest, WorkflowDefinition } from '@dramaflow/contracts';
export const manifest: NodeTypeManifest = {
  type: 'text.test',
  version: 1,
  executionKind: 'action',
  metadata: { name: '文本', category: 'ai' },
  inputs: [{ key: 'prompt', name: '提示词', dataType: { kind: 'primitive', name: 'string' } }],
  outputs: [
    { key: 'text', name: '文本', dataType: { kind: 'primitive', name: 'string' } },
    { key: 'video', name: '视频', dataType: { kind: 'named', name: 'media.video' } },
  ],
  config: [],
};
export function definition(): WorkflowDefinition {
  return {
    inputs: [],
    nodes: ['a', 'b'].map((id) => ({
      id,
      type: manifest.type,
      typeVersion: 1,
      name: id,
      inputs: {},
      config: {},
      ui: { position: { x: 0, y: 0 } },
    })),
    edges: [],
    outputs: [],
  };
}
