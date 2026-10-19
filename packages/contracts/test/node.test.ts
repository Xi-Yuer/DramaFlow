import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createWorkflowSchemas,
  edgeDefinitionSchema,
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
    inputs: [
      { target: 'script', source: { nodeId: 'script', outputKey: 'text' } },
      { target: 'characters', source: { nodeId: 'characters', outputKey: 'items' } },
      { target: 'style', source: { nodeId: 'style', outputKey: 'text' } },
    ],
    config: { prompt: '生成分镜', temperature: 0.5 },
    ui: { position: { x: 100, y: -50 } },
  };
}

describe('Node 定义与绑定协议', () => {
  it('保存多个明确上游、配置与布局，类型标识不预设节点目录', () => {
    const parsed = nodeDefinitionSchema.parse({ ...node(), type: 'video.image_to_video' });
    expect(parsed.inputs).toHaveLength(3);
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

  it('拒绝同一输入端口被多个来源重复绑定', () => {
    const definition = node();
    expect(
      nodeDefinitionSchema.safeParse({
        ...definition,
        inputs: [
          ...definition.inputs,
          { target: 'script', source: { nodeId: 'other', outputKey: 'text' } },
        ],
      }).success,
    ).toBe(false);
  });

  it('拒绝运行状态、旧式不明确的来源字段及非 JSON 配置', () => {
    for (const value of [
      { ...node(), status: 'running' },
      { ...node(), inputs: [{ target: 'script', source: { nodeId: 'script', output: 'text' } }] },
      { ...node(), config: { invalid: new Date() } },
      { ...node(), ui: { position: { x: Infinity, y: 0 } } },
      { ...node(), position: { x: 0, y: 0 } },
    ])
      expect(nodeDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it('Edge 保存平台中立的完整端口映射', () => {
    const edge = {
      id: 'e1',
      sourceNodeId: 'script',
      sourceHandle: 'text',
      targetNodeId: 'storyboard',
      targetHandle: 'script',
    };
    expect(edgeDefinitionSchema.parse(edge)).toEqual(edge);
    expect(edgeDefinitionSchema.safeParse({ ...edge, targetHandle: '' }).success).toBe(false);
    expect(edgeDefinitionSchema.safeParse({ ...edge, selected: true }).success).toBe(false);
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
      edge: edgeDefinitionSchema,
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
    status: 'pending',
    inputs: {},
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
      { ...run, outputs: { result: new Map() } },
      { ...run, startedAt: new Date() },
    ])
      expect(nodeRunSchema.safeParse(value).success).toBe(false);
  });
});
