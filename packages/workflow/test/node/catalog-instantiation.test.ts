import { describe, expect, it } from 'vitest';
import {
  StringType,
  instantiateNodeCatalogEntry,
  nodeDefinitionSchema,
  workflowDraftDefinitionSchema,
  type NodeCatalogEntry,
} from '@dramaflow/contracts';
import {
  NodeRegistry,
  createFormatTextNodeType,
  createSubworkflowNodeType,
  validateWorkflowForPublish,
} from '../../src/index.js';

describe('Catalog 实例复用现有 Draft / Publish 边界', () => {
  it('copy-on-create 的普通 Action 子图可以保存、重载、发布，无来源身份与专属 Runtime', () => {
    const runtime = new NodeRegistry([createFormatTextNodeType(), createSubworkflowNodeType()]);
    const entry: NodeCatalogEntry = {
      id: 'fixture-subgraph',
      metadata: { name: '测试组合' },
      exposure: 'public',
      category: 'data',
      target: { type: 'flow.subworkflow', version: 1 },
      creation: {
        inputs: { prompt: { type: 'constant', value: 'hello' } },
        composite: {
          kind: 'subworkflow',
          graph: {
            inputs: [{ name: 'prompt', type: StringType, required: true }],
            nodes: [
              {
                id: 'format',
                type: 'data.format_text',
                typeVersion: 1,
                name: '格式化',
                inputs: {
                  text: { type: 'workflow_input', key: 'prompt' },
                  index: { type: 'constant', value: 1 },
                },
                config: { template: '{{text}}-{{index}}' },
                ui: { position: { x: 0, y: 0 } },
              },
            ],
            edges: [],
            outputs: [
              { name: 'result', type: StringType, source: { nodeId: 'format', outputKey: 'text' } },
            ],
          },
        },
      },
    };
    const node = instantiateNodeCatalogEntry(entry, runtime.get('flow.subworkflow', 1).manifest, {
      id: 'call',
      position: { x: 4, y: 5 },
    });
    expect(nodeDefinitionSchema.parse(node)).toEqual(node);
    const definition = workflowDraftDefinitionSchema.parse(
      JSON.parse(
        JSON.stringify({
          inputs: [],
          nodes: [node],
          edges: [],
          outputs: [
            { name: 'result', type: StringType, source: { nodeId: 'call', outputKey: 'result' } },
          ],
        }),
      ),
    );
    expect(validateWorkflowForPublish(definition, runtime).map(({ node }) => node.type)).toEqual([
      'flow.subworkflow',
      'data.format_text',
    ]);
    expect(JSON.stringify(definition)).not.toContain(entry.id);
    expect(node).not.toHaveProperty('entryId');
  });
  it('条目仍可创建不完整 Draft，但不能绕过既有 Publish 校验', () => {
    const runtime = new NodeRegistry([createFormatTextNodeType()]);
    const entry: NodeCatalogEntry = {
      id: 'fixture-incomplete',
      metadata: { name: '未完成测试' },
      category: 'data',
      exposure: 'internal',
      target: { type: 'data.format_text', version: 1 },
      creation: {},
    };
    const node = instantiateNodeCatalogEntry(
      entry,
      runtime.getAction('data.format_text', 1).manifest,
      { id: 'format', position: { x: 0, y: 0 } },
    );
    expect(node.config.template).toBe('{{text}}-{{index}}');
    const draft = workflowDraftDefinitionSchema.parse({
      inputs: [],
      nodes: [node],
      edges: [],
      outputs: [],
    });
    expect(() => validateWorkflowForPublish(draft, runtime)).toThrow();
  });
});
