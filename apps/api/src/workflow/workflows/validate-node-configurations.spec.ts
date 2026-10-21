import { StringType, type WorkflowDefinition } from '@dramaflow/contracts';
import {
  createTextGenerationNodeType,
  NodeRegistry,
} from '@dramaflow/workflow';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

describe('已注册普通 Node 的保存 / 发布配置边界', () => {
  const registry = new NodeRegistry([createTextGenerationNodeType()]);

  it.each(['apiKey', 'secret', 'baseURL', 'model', 'provider'])(
    'Draft 和 Version 都拒绝额外字段 %s，响应不包含字段值',
    (field) => {
      const draft = definition({
        modelConfigurationId,
        [field]: 'secret-marker',
      });
      for (const phase of ['draft', 'publish'] as const) {
        expect(() =>
          validateWorkflowNodeConfigurations(draft, registry, phase),
        ).toThrow(
          expect.objectContaining({
            status: 400,
            response: {
              code: 'WORKFLOW_NODE_CONFIGURATION_INVALID',
              message: '工作流节点配置无效',
            },
          }),
        );
        try {
          validateWorkflowNodeConfigurations(draft, registry, phase);
        } catch (error) {
          expect(JSON.stringify(error)).not.toContain('secret-marker');
        }
      }
    },
  );

  it('Draft 允许暂未选择模型配置，发布必须通过正式 strict Schema', () => {
    const draft = definition({});
    expect(() =>
      validateWorkflowNodeConfigurations(draft, registry, 'draft'),
    ).not.toThrow();
    expect(() =>
      validateWorkflowNodeConfigurations(draft, registry, 'publish'),
    ).toThrow(expect.objectContaining({ status: 400 }));
    expect(() =>
      validateWorkflowNodeConfigurations(
        definition({ modelConfigurationId }),
        registry,
        'publish',
      ),
    ).not.toThrow();
  });

  it('不向草稿或发布定义回写 Schema 的默认值 / transform', () => {
    const type = createTextGenerationNodeType();
    const transformed = new NodeRegistry([
      {
        ...type,
        configSchema: z.object({
          modelConfigurationId: z
            .uuid()
            .default(modelConfigurationId)
            .transform((id) => id.toUpperCase()),
        }),
      },
    ]);
    const draft = definition({});
    const before = structuredClone(draft);
    validateWorkflowNodeConfigurations(draft, transformed, 'publish');
    expect(draft).toEqual(before);
  });

  it('未知类型保留编译阶段拒绝的既有行为，不扩展发布语义校验范围', () => {
    const draft = definition({ arbitrary: '旧定义' });
    draft.nodes[0]!.type = 'test.unregistered';
    for (const phase of ['draft', 'publish'] as const)
      expect(() =>
        validateWorkflowNodeConfigurations(draft, registry, phase),
      ).not.toThrow();
  });
});
