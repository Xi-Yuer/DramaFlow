import { describe, expect, it } from 'vitest';
import {
  StringType,
  instantiateNodeCatalogEntry,
  workflowDraftDefinitionSchema,
  workflowResponseSchema,
  nodeCatalogEntrySchema,
} from '@dramaflow/contracts';
import entryFixture from '../../../../../packages/server/test/fixtures/ai-text-composite-entry.json';
function createAiTextCompositeTestEntry() {
  return nodeCatalogEntrySchema.parse(entryFixture);
}
import { createSubworkflowNodeType } from '../../../../../packages/workflow/src/node/builtin/subworkflow';
import { createTextGenerationNodeType } from '../../../../../packages/workflow/src/node/builtin/text-generation';
import {
  createGraphNavigation,
  currentGraphLocation,
  editLocatedGraph,
  enterNestedGraph,
  popGraph,
  readLocatedGraph,
} from '../../../src/features/workflow/editor/navigation/graph-navigation';
import {
  createWorkflowDraftState,
  workflowDraftReducer,
} from '../../../src/features/workflow/editor/draft/workflow-draft-state';
import { replaceNodeInput } from '../../../src/features/workflow/inputs/template/binding';
import { resolveWorkflowNodePorts } from '../../../src/features/workflow/ports/resolve-workflow-node-ports';
import {
  fromReactFlowNode,
  toReactFlowNode,
} from '../../../src/features/workflow/canvas/adapter/node-adapter';

describe('真实 AI 文本 Catalog 实例的 Web 编辑链路', () => {
  it('动态端口、进入子图、编辑 prompt / 模型配置、返回及 Draft 重载保留所有正式 Binding', () => {
    const entry = createAiTextCompositeTestEntry();
    const manifest = createSubworkflowNodeType().manifest;
    const node = instantiateNodeCatalogEntry(entry, manifest, {
      id: 'process_text',
      position: { x: 320, y: 160 },
    });
    node.inputs.text = { type: 'workflow_input', key: 'text' };
    const definition = workflowDraftDefinitionSchema.parse({
      inputs: [{ name: 'text', type: StringType, required: true }],
      nodes: [node],
      edges: [],
      outputs: [
        { name: 'result', type: StringType, source: { nodeId: node.id, outputKey: 'result' } },
      ],
    });
    expect(resolveWorkflowNodePorts(node, manifest)).toMatchObject({
      inputs: [{ key: 'text', dataType: StringType }],
      outputs: [{ key: 'result', dataType: StringType }],
    });
    expect(createTextGenerationNodeType().manifest.config).toContainEqual(
      expect.objectContaining({ key: 'modelConfigurationId', ui: { component: 'model-selector' } }),
    );
    let navigation = enterNestedGraph(
      createGraphNavigation({ x: 0, y: 0, zoom: 1 }),
      definition,
      node.id,
    );
    const location = currentGraphLocation(navigation);
    expect(location).toEqual([{ nodeId: 'process_text', graphKey: 'graph' }]);
    const binding = {
      type: 'template' as const,
      value: '用一句话概括：{{text}}',
      variables: { text: { type: 'workflow_input' as const, key: 'text' } },
    };
    const modelConfigurationId = '00000000-0000-4000-8000-000000000001';
    const edited = editLocatedGraph(definition, location, (graph) => {
      const updated = replaceNodeInput(graph, 'generate', 'prompt', binding);
      return {
        ...updated,
        nodes: updated.nodes.map((action) =>
          fromReactFlowNode(toReactFlowNode({ ...action, config: { modelConfigurationId } })),
        ),
      };
    });
    navigation = popGraph(navigation);
    expect(currentGraphLocation(navigation)).toEqual([]);
    expect(edited.outputs).toEqual(definition.outputs);
    expect(edited.nodes[0]!.inputs).toEqual(node.inputs);
    expect(entry).toEqual(createAiTextCompositeTestEntry());
    const response = workflowResponseSchema.parse({
      id: 'workflow',
      projectId: '00000000-0000-4000-8000-000000000002',
      name: '默认工作流',
      revision: 1,
      draft: definition,
      createdAt: '2026-10-27T00:00:00.000Z',
      updatedAt: '2026-10-27T00:00:00.000Z',
    });
    let state = workflowDraftReducer(createWorkflowDraftState(response), {
      type: 'edit',
      definition: edited,
    });
    const snapshot = workflowDraftDefinitionSchema.parse(
      JSON.parse(JSON.stringify(state.definition)),
    );
    state = workflowDraftReducer(state, { type: 'save-succeeded', revision: 2, snapshot });
    state = workflowDraftReducer(state, {
      type: 'reload-succeeded',
      workflow: workflowResponseSchema.parse({ ...response, revision: 2, draft: snapshot }),
    });
    expect(state.revision).toBe(2);
    expect(state.definition).toEqual(edited);
    expect(readLocatedGraph(state.definition, location)?.nodes[0]).toMatchObject({
      type: 'ai.text_generate',
      config: { modelConfigurationId },
      inputs: {
        prompt: binding,
        system:
          entry.creation.composite?.kind === 'subworkflow'
            ? entry.creation.composite.graph.nodes[0]!.inputs.system
            : undefined,
      },
    });
    expect(resolveWorkflowNodePorts(state.definition.nodes[0]!, manifest)).toEqual(
      resolveWorkflowNodePorts(node, manifest),
    );
  });
});
