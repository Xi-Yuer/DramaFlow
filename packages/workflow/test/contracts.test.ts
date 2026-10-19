import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createWorkflowSchemas } from '@dramaflow/contracts';
import {
  assertWorkflowRunVersion,
  collectWorkflowOutputs,
  createWorkflowVersionSnapshot,
  parseWorkflowInputs,
  WorkflowContractError,
} from '../src/index.js';

describe('Workflow 输入值校验', () => {
  const contracts = [
    { name: 'novel', schema: z.string().min(1) },
    { name: 'targetEpisodeCount', schema: z.number().int().positive() },
    { name: 'platform', schema: z.enum(['douyin', 'bilibili']) },
  ];
  const values = { novel: '小说正文', targetEpisodeCount: 10, platform: 'douyin' };

  it('按完整契约校验值并复制复合数据，避免与调用方共享可变对象', () => {
    const input = { items: [{ text: '分镜' }] };
    const result = parseWorkflowInputs(
      [{ name: 'items', schema: z.array(z.object({ text: z.string() }).strict()) }],
      input,
    );
    input.items[0]!.text = '已修改';
    expect(result).toEqual({ items: [{ text: '分镜' }] });
  });

  it('拒绝缺失必填值、错误类型、非法枚举与未声明字段', () => {
    for (const input of [
      { ...values, novel: undefined },
      { ...values, targetEpisodeCount: '10' },
      { ...values, platform: 'unknown' },
      { ...values, secret: 'test-only' },
    ]) {
      expect(() => parseWorkflowInputs(contracts, input)).toThrow(z.ZodError);
    }
  });

  it('只应用具体 Schema 明确声明的默认值和可选字段', () => {
    expect(
      parseWorkflowInputs(
        [
          { name: 'style', schema: z.string().default('动画') },
          { name: 'note', schema: z.string().optional() },
        ],
        {},
      ),
    ).toEqual({ style: '动画' });
  });

  it('拒绝重复契约名和非 JSON 值', () => {
    expect(() => parseWorkflowInputs([...contracts, contracts[0]!], values)).toThrow(
      WorkflowContractError,
    );
    expect(() =>
      parseWorkflowInputs([{ name: 'createdAt', schema: z.date() }], { createdAt: new Date() }),
    ).toThrow(z.ZodError);
  });
});

describe('Workflow 最终结果收集', () => {
  const contracts = [
    { name: 'cover', schema: z.string(), source: { nodeId: 'image', outputKey: 'imageRef' } },
    { name: 'publishText', schema: z.string(), source: { nodeId: 'copy', outputKey: 'text' } },
  ];

  it('按显式绑定收集多个来源，仅暴露声明的结果', () => {
    const results = new Map([
      ['copy', { text: '发布文案', internal: '内部值' }],
      ['image', { imageRef: 'asset-version-1' }],
      ['last', { irrelevant: '最后完成的节点' }],
    ]);
    expect(collectWorkflowOutputs(contracts, results)).toEqual({
      cover: 'asset-version-1',
      publishText: '发布文案',
    });
  });

  it('来源节点缺失时不取其他节点作为替代', () => {
    expect(() => collectWorkflowOutputs(contracts, new Map())).toThrow(
      expect.objectContaining({ code: 'missing_node_result' }),
    );
  });

  it('拒绝缺失来源键和继承而来的属性', () => {
    for (const result of [{}, Object.create({ imageRef: 'inherited' })]) {
      expect(() => collectWorkflowOutputs([contracts[0]!], new Map([['image', result]]))).toThrow(
        expect.objectContaining({ code: 'missing_node_output' }),
      );
    }
  });

  it('实际结果类型不合约时拒绝完成', () => {
    expect(() =>
      collectWorkflowOutputs([contracts[0]!], new Map([['image', { imageRef: 42 }]])),
    ).toThrow(z.ZodError);
  });
});

describe('Workflow 版本快照与运行绑定', () => {
  // 显式测试 Schema，不提供生产节点或执行适配器。
  const schemas = createWorkflowSchemas({
    dataType: z.literal('text'),
    node: z.object({ id: z.string(), config: z.object({ prompt: z.string() }).strict() }).strict(),
    edge: z.never(),
  });
  const metadata = {
    id: 'version-1',
    workflowId: 'workflow-1',
    version: 1,
    publishedAt: '2026-10-19T00:00:00.000Z',
  };

  it('复制并深度冻结完整定义，后续草稿修改不会改变快照', () => {
    const draft = {
      inputs: [{ name: 'novel', type: 'text' }],
      nodes: [{ id: 'script', config: { prompt: '原始提示词' } }],
      edges: [],
      outputs: [{ name: 'text', type: 'text', source: { nodeId: 'script', outputKey: 'text' } }],
    };
    const snapshot = createWorkflowVersionSnapshot(schemas.versionSchema, {
      ...metadata,
      definition: draft,
    });
    draft.nodes[0]!.config.prompt = '新提示词';
    draft.inputs[0]!.name = 'changed';
    draft.outputs[0]!.source.nodeId = 'changed';
    expect(snapshot.definition.nodes[0]?.config.prompt).toBe('原始提示词');
    expect(snapshot.definition.inputs[0]?.name).toBe('novel');
    expect(snapshot.definition.outputs[0]?.source.nodeId).toBe('script');
    expect(Object.isFrozen(snapshot.definition.nodes[0]?.config)).toBe(true);
    expect(Reflect.set(snapshot.definition.nodes[0]!.config, 'prompt', '修改')).toBe(false);
    expect(Reflect.set(snapshot.definition.nodes, '0', {})).toBe(false);
    expect(Object.isFrozen(snapshot.definition.inputs)).toBe(true);
    expect(Object.isFrozen(snapshot.definition.outputs[0]?.source)).toBe(true);
  });

  it('快照生成前拒绝不符合定义 Schema 的数据', () => {
    expect(() =>
      createWorkflowVersionSnapshot(schemas.versionSchema, { ...metadata, definition: {} }),
    ).toThrow(z.ZodError);
  });

  it('即使调用方 Schema 接受特殊对象，版本快照也拒绝非 JSON 数据', () => {
    const versionSchema = z
      .object({
        ...schemas.versionSchema.shape,
        definition: z.object({ createdAt: z.date() }).strict(),
      })
      .strict();
    expect(() =>
      createWorkflowVersionSnapshot(versionSchema, {
        ...metadata,
        definition: { createdAt: new Date() },
      }),
    ).toThrow(z.ZodError);
  });

  it('拒绝版本或工作流身份不匹配的运行', () => {
    const run = {
      id: 'run-1',
      workflowId: 'workflow-1',
      workflowVersionId: 'version-1',
      status: 'waiting' as const,
    };
    expect(() => assertWorkflowRunVersion(run, metadata)).not.toThrow();
    for (const invalid of [
      { ...run, workflowId: 'another' },
      { ...run, workflowVersionId: 'version-2' },
    ]) {
      expect(() => assertWorkflowRunVersion(invalid, metadata)).toThrow(
        expect.objectContaining({ code: 'version_mismatch' }),
      );
    }
  });
});
