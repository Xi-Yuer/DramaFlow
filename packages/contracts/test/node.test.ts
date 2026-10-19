import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createWorkflowSchemas,
  controlEdgeDefinitionSchema,
  inputBindingSchema,
  nodeDefinitionSchema,
  nodePresetSchema,
  nodeRunSchema,
  nodeRunStatusSchema,
} from '../src/index.js';

function node() {
  return {
    id: 'storyboard',
    type: 'ai.llm',
    typeVersion: 1,
    name: '生成分镜',
    preset: 'storyboard-generator',
    inputs: {
      script: { type: 'connection', nodeId: 'script', outputKey: 'text' },
      characters: { type: 'connection', nodeId: 'characters', outputKey: 'items' },
      style: { type: 'constant', value: '黑白' },
      novel: { type: 'workflow_input', key: 'novel' },
      reference: { type: 'asset', assetId: 'unread-asset' },
    },
    config: { prompt: '生成分镜', temperature: 0.5 },
    ui: { position: { x: 100, y: -50 } },
  };
}

describe('Node 定义与绑定协议', () => {
  it('保存多个明确上游、配置与布局，类型标识不预设节点目录', () => {
    const parsed = nodeDefinitionSchema.parse({ ...node(), type: 'video.image_to_video' });
    expect(Object.keys(parsed.inputs)).toHaveLength(5);
    expect(parsed.inputs.reference).toEqual({ type: 'asset', assetId: 'unread-asset' });
    expect(parsed.type).toBe('video.image_to_video');
    expect(parsed.typeVersion).toBe(1);
    expect(parsed.ui?.position).toEqual({ x: 100, y: -50 });
  });

  it('要求命名空间类型与明确正整数版本，不猜测类型或版本', () => {
    for (const value of [
      { ...node(), type: 'llm' },
      { ...node(), type: 'AI.llm' },
      { ...node(), typeVersion: undefined },
      { ...node(), typeVersion: 0 },
      { ...node(), typeVersion: 1.5 },
    ]) {
      expect(nodeDefinitionSchema.safeParse(value).success).toBe(false);
    }
  });

  it('每个输入端口保存一个明确来源，拒绝旧数组和不安全键', () => {
    for (const inputs of [
      [{ target: 'script', source: { nodeId: 'script', outputKey: 'text' } }],
      { constructor: { type: 'constant', value: 'unsafe' } },
      {
        script: [
          { type: 'constant', value: 'a' },
          { type: 'constant', value: 'b' },
        ],
      },
    ])
      expect(nodeDefinitionSchema.safeParse({ ...node(), inputs }).success).toBe(false);
  });

  it('四类绑定分别校验字段，常量只接受 JSON，不解析资产', () => {
    expect(
      inputBindingSchema.parse({ type: 'constant', value: { nested: [null, false, 0, ''] } }),
    ).toEqual({ type: 'constant', value: { nested: [null, false, 0, ''] } });
    expect(inputBindingSchema.parse({ type: 'asset', assetId: 'not-loaded' })).toEqual({
      type: 'asset',
      assetId: 'not-loaded',
    });
    for (const binding of [
      { type: 'constant', value: undefined },
      { type: 'constant', value: new Date() },
      { type: 'constant', value: () => 'text' },
      { type: 'constant', value: Infinity },
      { type: 'connection', nodeId: 'script', output: 'text' },
      { type: 'workflow_input', key: 'bad.key' },
      { type: 'asset', assetId: '' },
      { type: 'asset', assetId: 'a1', url: 'local://asset' },
      { type: 'expression', expression: 'state.x' },
    ])
      expect(inputBindingSchema.safeParse(binding).success).toBe(false);
  });

  it('拒绝运行状态、旧式不明确的来源字段及非 JSON 配置', () => {
    for (const value of [
      { ...node(), status: 'running' },
      { ...node(), inputs: [{ target: 'script', source: { nodeId: 'script', output: 'text' } }] },
      { ...node(), config: { invalid: new Date() } },
      { ...node(), ui: { position: { x: Infinity, y: 0 } } },
      { ...node(), ui: undefined },
      { ...node(), position: { x: 0, y: 0 } },
    ])
      expect(nodeDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it('ControlEdge 只保存执行路由，拒绝旧数据边字段和编辑状态', () => {
    const edge = {
      id: 'e1',
      sourceNodeId: 'condition',
      sourcePort: 'yes',
      targetNodeId: 'storyboard',
    };
    expect(controlEdgeDefinitionSchema.parse(edge)).toEqual(edge);
    expect(
      controlEdgeDefinitionSchema.parse({ id: 'e2', sourceNodeId: 'a', targetNodeId: 'b' })
        .sourcePort,
    ).toBeUndefined();
    for (const value of [
      { ...edge, sourcePort: '' },
      { ...edge, sourceHandle: 'text' },
      { ...edge, targetHandle: 'script' },
      { ...edge, selected: true },
    ])
      expect(controlEdgeDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it('Preset 仅保存类型归属与显式配置，不保存可执行函数', () => {
    const preset = {
      id: 'storyboard-generator',
      type: 'ai.llm',
      typeVersion: 1,
      name: '生成分镜',
      config: { prompt: '分镜提示词' },
    };
    expect(nodePresetSchema.parse(preset)).toEqual(preset);
    expect(nodePresetSchema.safeParse({ ...preset, typeVersion: undefined }).success).toBe(false);
    expect(nodePresetSchema.safeParse({ ...preset, typeVersion: -1 }).success).toBe(false);
    expect(nodePresetSchema.safeParse({ ...preset, execute: () => ({}) }).success).toBe(false);
  });

  it('现有 Workflow Schema 可直接组合真实 Node 与 Edge 协议', () => {
    const schemas = createWorkflowSchemas({
      dataType: z.literal('text'),
      node: nodeDefinitionSchema,
      edge: controlEdgeDefinitionSchema,
    });
    const definition = {
      inputs: [],
      nodes: [node()],
      edges: [],
      outputs: [
        { name: 'shots', type: 'text', source: { nodeId: 'storyboard', outputKey: 'shots' } },
      ],
    };
    expect(schemas.definitionSchema.parse(definition).nodes[0]?.preset).toBe(
      'storyboard-generator',
    );
  });
});

describe('NodeRun 记录协议', () => {
  const run = {
    id: 'nr1',
    workflowRunId: 'wr1',
    nodeId: 'storyboard',
    attempt: 1,
    status: 'pending',
  };

  it('支持八种状态，并与静态 NodeDefinition 分离', () => {
    for (const status of [
      'pending',
      'ready',
      'running',
      'waiting',
      'completed',
      'failed',
      'skipped',
      'cancelled',
    ]) {
      expect(nodeRunSchema.parse({ ...run, status }).status).toBe(status);
    }
    expect(nodeRunStatusSchema.safeParse('retrying').success).toBe(false);
    expect(nodeRunSchema.safeParse({ ...run, config: {} }).success).toBe(false);
  });

  it('接收结构化错误和 ISO 时间，拒绝原始 Error 与非 JSON 结果', () => {
    expect(
      nodeRunSchema.parse({
        ...run,
        status: 'failed',
        error: { code: 'outcome_unknown', message: '供应商受理结果未知' },
      }).error?.code,
    ).toBe('outcome_unknown');
    for (const value of [
      { ...run, error: new Error('原始错误') },
      { ...run, inputSnapshot: { result: new Map() } },
      { ...run, outputSnapshot: { result: new Map() } },
      { ...run, outputSnapshot: { video: new Uint8Array([1, 2]) } },
      { ...run, startedAt: new Date() },
    ])
      expect(nodeRunSchema.safeParse(value).success).toBe(false);
  });

  it('待执行和绑定失败可以没有快照，明确空输入与没有快照是两种记录', () => {
    expect(nodeRunSchema.parse(run)).not.toHaveProperty('inputSnapshot');
    expect(nodeRunSchema.parse(run)).not.toHaveProperty('outputSnapshot');
    expect(nodeRunSchema.parse({ ...run, inputSnapshot: {} }).inputSnapshot).toEqual({});
    expect(
      nodeRunSchema.parse({
        ...run,
        status: 'failed',
        error: { code: 'invalid_input', message: '输入绑定无效' },
      }),
    ).not.toHaveProperty('inputSnapshot');
  });

  it('attempt 必须显式为正整数，旧输入输出字段不能混入历史记录', () => {
    for (const attempt of [undefined, 0, -1, 1.5, '1', Infinity]) {
      expect(nodeRunSchema.safeParse({ ...run, attempt }).success).toBe(false);
    }
    for (const legacy of [{ inputs: {} }, { outputs: {} }]) {
      expect(nodeRunSchema.safeParse({ ...run, ...legacy }).success).toBe(false);
    }
  });

  it('同一节点的多次执行分别保存快照，记录不会共享调用方的可变对象', () => {
    const input = { story: { text: '原始输入' } };
    const first = nodeRunSchema.parse({
      ...run,
      status: 'completed',
      inputSnapshot: input,
      outputSnapshot: { script: '第一版' },
    });
    const second = nodeRunSchema.parse({
      ...run,
      id: 'nr2',
      attempt: 2,
      status: 'completed',
      inputSnapshot: input,
      outputSnapshot: { script: '第二版' },
    });
    input.story.text = '后续修改';
    expect(first.inputSnapshot).toEqual({ story: { text: '原始输入' } });
    expect(second.inputSnapshot).toEqual(first.inputSnapshot);
    expect(first.outputSnapshot).toEqual({ script: '第一版' });
    expect(second.outputSnapshot).toEqual({ script: '第二版' });
  });
});
