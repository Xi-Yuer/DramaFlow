import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createWorkflowSchemas,
  dataEdgeDefinitionSchema,
  staticInputBindingSchema,
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
      style: { type: 'constant', value: '黑白' },
      novel: { type: 'workflow_input', key: 'novel' },
      reference: { type: 'asset', assetId: 'unread-asset', versionId: 'asset-version-1' },
    },
    config: { prompt: '生成分镜', temperature: 0.5 },
    ui: { position: { x: 100, y: -50 } },
  };
}

describe('Node 定义与绑定协议', () => {
  it('保存静态输入来源、配置与布局，类型标识不预设节点目录', () => {
    const parsed = nodeDefinitionSchema.parse({ ...node(), type: 'video.image_to_video' });
    expect(Object.keys(parsed.inputs)).toHaveLength(3);
    expect(parsed.inputs.reference).toEqual({
      type: 'asset',
      assetId: 'unread-asset',
      versionId: 'asset-version-1',
    });
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

  it('三类静态绑定分别校验字段，常量只接受 JSON，不解析资产', () => {
    expect(
      staticInputBindingSchema.parse({ type: 'constant', value: { nested: [null, false, 0, ''] } }),
    ).toEqual({ type: 'constant', value: { nested: [null, false, 0, ''] } });
    expect(
      staticInputBindingSchema.parse({
        type: 'asset',
        assetId: 'not-loaded',
        versionId: 'asset-version-1',
      }),
    ).toEqual({
      type: 'asset',
      assetId: 'not-loaded',
      versionId: 'asset-version-1',
    });
    for (const binding of [
      { type: 'constant', value: undefined },
      { type: 'constant', value: new Date() },
      { type: 'constant', value: () => 'text' },
      { type: 'constant', value: Infinity },
      { type: 'connection', nodeId: 'script', outputKey: 'text' },
      { type: 'workflow_input', key: 'bad.key' },
      { type: 'asset', assetId: '', versionId: 'asset-version-1' },
      { type: 'asset', assetId: 'a1', versionId: 'asset-version-1', url: 'local://asset' },
      { type: 'expression', expression: 'state.x' },
    ])
      expect(staticInputBindingSchema.safeParse(binding).success).toBe(false);
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

  it('DataEdge 保存明确端口，拒绝控制边、旧字段和编辑状态', () => {
    const edge = {
      id: 'e1',
      kind: 'data',
      source: { nodeId: 'script', portKey: 'text' },
      target: { nodeId: 'storyboard', portKey: 'script' },
    };
    expect(dataEdgeDefinitionSchema.parse(edge)).toEqual(edge);
    for (const value of [
      { ...edge, sourcePort: 'yes' },
      { ...edge, sourceHandle: 'text' },
      { ...edge, targetHandle: 'script' },
      { ...edge, selected: true },
      { ...edge, kind: 'control' },
      { id: 'legacy', sourceNodeId: 'script', targetNodeId: 'storyboard' },
      { ...edge, source: { nodeId: 'script', outputKey: 'text' } },
      { ...edge, target: { nodeId: 'storyboard', portKey: 'bad.key' } },
    ])
      expect(dataEdgeDefinitionSchema.safeParse(value).success).toBe(false);
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
      edge: dataEdgeDefinitionSchema,
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
    status: 'running',
    startedAt: '2026-10-20T00:00:00.000Z',
  };
  const text = (value: string) => ({
    storage: 'inline',
    type: { kind: 'primitive', name: 'string' },
    value,
  });

  it('只接受普通 Action 的三种状态，要求开始时间且与静态定义分离', () => {
    for (const status of ['running', 'completed', 'failed'])
      expect(nodeRunSchema.parse({ ...run, status }).status).toBe(status);
    for (const status of ['pending', 'ready', 'waiting', 'skipped', 'cancelled', 'retrying'])
      expect(nodeRunStatusSchema.safeParse(status).success).toBe(false);
    expect(nodeRunSchema.safeParse({ ...run, startedAt: undefined }).success).toBe(false);
    expect(nodeRunSchema.safeParse({ ...run, config: {} }).success).toBe(false);
  });

  it('保存结构化阶段错误与 ISO 时间，拒绝原始异常、未知阶段和业务快照', () => {
    const error = { code: 'NODE_EXECUTION_FAILED', message: '业务执行失败', stage: 'execute' };
    expect(nodeRunSchema.parse({ ...run, status: 'failed', error }).error).toEqual(error);
    for (const value of [
      { ...run, error: new Error('原始错误') },
      { ...run, error: { ...error, stage: 'unknown' } },
      { ...run, inputs: { result: '原始字符串' } },
      { ...run, outputs: { result: new Map() } },
      { ...run, outputs: { video: new Uint8Array([1, 2]) } },
      { ...run, startedAt: new Date() },
      { ...run, inputSnapshot: {} },
      { ...run, outputSnapshot: {} },
    ])
      expect(nodeRunSchema.safeParse(value).success).toBe(false);
  });

  it('Binding 失败可没有 inputs，空输入和未解析输入仍是两种记录', () => {
    expect(nodeRunSchema.parse(run)).not.toHaveProperty('inputs');
    expect(nodeRunSchema.parse({ ...run, inputs: {} }).inputs).toEqual({});
    expect(
      nodeRunSchema.parse({
        ...run,
        status: 'failed',
        error: { code: 'INPUT_SOURCE_CONFLICT', message: '输入冲突', stage: 'resolve_input' },
      }),
    ).not.toHaveProperty('inputs');
  });

  it('inputs / outputs 使用 RuntimeValue，资产固定版本，视频只存 ArtifactReference', () => {
    const value = nodeRunSchema.parse({
      ...run,
      inputs: {
        image: {
          storage: 'reference',
          type: { kind: 'named', name: 'media.image' },
          reference: { kind: 'asset', id: 'image', versionId: 'v3' },
        },
      },
      outputs: {
        video: {
          storage: 'reference',
          type: { kind: 'named', name: 'media.video' },
          reference: { kind: 'artifact', id: 'video' },
        },
      },
    });
    expect(value.inputs?.image).toMatchObject({ reference: { versionId: 'v3' } });
    expect(value.outputs?.video).toMatchObject({ reference: { kind: 'artifact', id: 'video' } });
    for (const attempt of [undefined, 0, -1, 1.5, '1', Infinity])
      expect(nodeRunSchema.safeParse({ ...run, attempt }).success).toBe(false);
  });

  it('两次执行保存独立 RuntimeValue map，不共享调用方的可变对象', () => {
    const inputs = { prompt: text('原始输入') };
    const first = nodeRunSchema.parse({ ...run, inputs, outputs: { script: text('第一版') } });
    const second = nodeRunSchema.parse({
      ...run,
      id: 'nr2',
      attempt: 2,
      inputs,
      outputs: { script: text('第二版') },
    });
    inputs.prompt.value = '后续修改';
    expect(first.inputs?.prompt).toMatchObject({ value: '原始输入' });
    expect(second.inputs).toEqual(first.inputs);
    expect(first.outputs?.script).toMatchObject({ value: '第一版' });
    expect(second.outputs?.script).toMatchObject({ value: '第二版' });
  });
});
