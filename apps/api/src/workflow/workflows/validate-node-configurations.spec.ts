import {
  StringType,
  saveWorkflowDraftRequestSchema,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  createTextGenerationNodeType,
  createHumanReviewNodeType,
  createIterationNodeType,
  NodeRegistry,
} from '@dramaflow/workflow';
import { describe, expect, it } from 'vitest';
import { validateWorkflowNodeConfigurations } from './validate-node-configurations.js';

const modelConfigurationId = 'da054b80-9d86-4d23-a1c9-31bc416f91f1';

function definition(
  config: WorkflowDefinition['nodes'][number]['config'],
): WorkflowDefinition {
  return {
    inputs: [],
    nodes: [
      {
        id: 'text',
        type: 'ai.text_generate',
        typeVersion: 1,
        name: '文本生成',
        inputs: { prompt: { type: 'constant', value: '编写对白' } },
        config,
        ui: { position: { x: 0, y: 0 } },
      },
    ],
    edges: [],
    outputs: [
      {
        name: 'text',
        type: StringType,
        source: { nodeId: 'text', outputKey: 'text' },
      },
    ],
  };
}

describe('Draft 配置字段边界', () => {
  it('正式 Human Review 的完整或未完成草稿均可通过保存前配置边界', () => {
    const types = new NodeRegistry([
      createTextGenerationNodeType(),
      createHumanReviewNodeType(),
    ]);
    for (const complete of [false, true]) {
      const draft = definition(complete ? { instruction: '核对人物' } : {});
      const node = draft.nodes[0]!;
      node.type = 'flow.human_review';
      node.name = '人工审核标题';
      node.inputs = complete
        ? { content: { type: 'constant', value: '待审核文本' } }
        : {};
      draft.outputs = [];
      const request = { expectedRevision: 1, definition: draft };
      expect(saveWorkflowDraftRequestSchema.parse(request)).toEqual(request);
      expect(() =>
        validateWorkflowNodeConfigurations(draft, types),
      ).not.toThrow();
    }
  });
  const registry = new NodeRegistry([createTextGenerationNodeType()]);

  it.each(['apiKey', 'secret', 'baseURL', 'model', 'provider'])(
    'Draft 拒绝额外字段 %s，错误不包含字段值',
    (field) => {
      const draft = definition({
        modelConfigurationId,
        [field]: 'secret-marker',
      });
      expect(() => validateWorkflowNodeConfigurations(draft, registry)).toThrow(
        expect.objectContaining({ status: 400 }),
      );
      try {
        validateWorkflowNodeConfigurations(draft, registry);
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain('secret-marker');
      }
    },
  );

  it('Draft 可暂缺模型和必填输入，完整校验只在发布发生', () => {
    const draft = definition({});
    draft.nodes[0]!.inputs = {};
    expect(() =>
      validateWorkflowNodeConfigurations(draft, registry),
    ).not.toThrow();
  });

  it('未知类型可保留在编辑草稿中', () => {
    const draft = definition({ arbitrary: '编辑中' });
    draft.nodes[0]!.type = 'test.unregistered';
    expect(() =>
      validateWorkflowNodeConfigurations(draft, registry),
    ).not.toThrow();
  });
});

it('Iteration Draft 不要求完成映射，但递归拒绝 body 与 composite config 中的额外密钥字段', () => {
  const types = new NodeRegistry([
    createIterationNodeType(),
    createTextGenerationNodeType(),
  ]);
  const body = definition({});
  const draft: WorkflowDefinition = {
    inputs: [],
    edges: [],
    outputs: [],
    nodes: [
      {
        id: 'iterate',
        type: 'flow.iteration',
        typeVersion: 1,
        name: '逐项',
        inputs: {},
        config: {},
        ui: { position: { x: 0, y: 0 } },
        composite: {
          kind: 'iteration',
          itemType: StringType,
          invariantInputs: [],
          body,
          bodyInputMapping: [],
        },
      },
    ],
  };
  expect(
    saveWorkflowDraftRequestSchema.safeParse({
      expectedRevision: 1,
      definition: draft,
    }).success,
  ).toBe(true);
  expect(() => validateWorkflowNodeConfigurations(draft, types)).not.toThrow();
  body.nodes[0]!.config = { secret: 'secret-marker' };
  expect(() => validateWorkflowNodeConfigurations(draft, types)).toThrow(
    expect.objectContaining({ status: 400 }),
  );
  body.nodes[0]!.config = {};
  draft.nodes[0]!.config = { body: 'secret-marker' };
  expect(() => validateWorkflowNodeConfigurations(draft, types)).toThrow(
    expect.objectContaining({ status: 400 }),
  );
});
