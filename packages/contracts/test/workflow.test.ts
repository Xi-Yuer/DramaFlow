import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createWorkflowSchemas,
  workflowRunMetadataSchema,
  workflowRunStatusSchema,
  workflowVersionMetadataSchema,
} from '../src/workflow.js';

// 仅用于测试组合校验器，不作为生产 Node / Edge / DataType 定义。
const schemas = createWorkflowSchemas({
  dataType: z.enum(['text', 'number']),
  node: z.object({ id: z.string().min(1), label: z.string() }).strict(),
  edge: z.object({ source: z.string(), target: z.string() }).strict(),
});

function definition() {
  return {
    inputs: [{ name: 'novel', type: 'text' }],
    nodes: [{ id: 'script', label: '剧本' }],
    edges: [],
    outputs: [
      { name: 'scriptText', type: 'text', source: { nodeId: 'script', outputKey: 'text' } },
    ],
  };
}

describe('Workflow 定义组合校验', () => {
  it('保留调用方定义的具体节点字段，并将输入输出纳入同一版本', () => {
    const result = schemas.versionSchema.parse({
      id: 'version-1',
      workflowId: 'workflow-1',
      version: 1,
      publishedAt: '2026-10-19T00:00:00.000Z',
      definition: definition(),
    });
    expect(result.definition.nodes[0]?.label).toBe('剧本');
    expect(result.definition.inputs[0]?.name).toBe('novel');
    expect(result.definition.outputs[0]?.name).toBe('scriptText');
  });

  it('拒绝运行状态、密钥及独立并行列表进入静态定义', () => {
    for (const extra of [{ status: 'running' }, { apiKey: 'test-only' }, { parallelNodes: [] }]) {
      expect(schemas.definitionSchema.safeParse({ ...definition(), ...extra }).success).toBe(false);
    }
  });

  it('实际使用调用方的 Node、Edge 与 DataType 校验器', () => {
    expect(
      schemas.definitionSchema.safeParse({ ...definition(), nodes: [{ id: 'script' }] }).success,
    ).toBe(false);
    expect(
      schemas.definitionSchema.safeParse({ ...definition(), edges: [{ invalid: true }] }).success,
    ).toBe(false);
    expect(
      schemas.definitionSchema.safeParse({
        ...definition(),
        inputs: [{ name: 'novel', type: 'unsupported' }],
      }).success,
    ).toBe(false);
  });

  it.each(['inputs', 'nodes', 'outputs'] as const)('拒绝 %s 中的重复名称或标识', (field) => {
    const draft = definition();
    expect(
      schemas.definitionSchema.safeParse({ ...draft, [field]: [...draft[field], ...draft[field]] })
        .success,
    ).toBe(false);
  });

  it('拒绝不存在的输出来源节点及不明确的来源键', () => {
    for (const source of [
      { nodeId: 'missing', outputKey: 'text' },
      { nodeId: 'script', outputKey: '' },
    ]) {
      expect(
        schemas.definitionSchema.safeParse({
          ...definition(),
          outputs: [{ name: 'scriptText', type: 'text', source }],
        }).success,
      ).toBe(false);
    }
  });

  it.each(['__proto__', 'constructor', 'prototype', 'cover.image', ''])(
    '拒绝不安全或不明确的契约名称 %s',
    (name) => {
      expect(schemas.inputSchema.safeParse({ name, type: 'text' }).success).toBe(false);
    },
  );
});

describe('版本及运行元数据', () => {
  it('版本编号不能使用零、负数或小数，时间须为 ISO 字符串', () => {
    const metadata = {
      id: 'v1',
      workflowId: 'w1',
      version: 1,
      publishedAt: '2026-10-19T00:00:00.000Z',
    };
    for (const version of [0, -1, 1.5]) {
      expect(workflowVersionMetadataSchema.safeParse({ ...metadata, version }).success).toBe(false);
    }
    expect(
      workflowVersionMetadataSchema.safeParse({ ...metadata, publishedAt: new Date() }).success,
    ).toBe(false);
  });

  it('支持六种基础状态，拒绝未知状态与把完整输入混入元数据', () => {
    for (const status of ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled']) {
      expect(workflowRunStatusSchema.parse(status)).toBe(status);
    }
    expect(workflowRunStatusSchema.safeParse('paused').success).toBe(false);
    const run = {
      id: 'run-1',
      workflowId: 'w1',
      workflowVersionId: 'v1',
      threadId: 'thread-1',
      status: 'waiting',
    };
    expect(workflowRunMetadataSchema.parse(run)).toEqual(run);
    expect(workflowRunMetadataSchema.safeParse({ ...run, inputs: {} }).success).toBe(false);
  });

  it('threadId 是必填独立标识，不从 Run.id 隐式推断', () => {
    const run = {
      id: 'run-1',
      workflowId: 'w1',
      workflowVersionId: 'v1',
      threadId: 'root-thread-1',
      status: 'pending',
    };
    expect(workflowRunMetadataSchema.parse(run).threadId).toBe('root-thread-1');
    expect(workflowRunMetadataSchema.parse({ ...run, threadId: run.id }).threadId).toBe(run.id);
    for (const threadId of [undefined, '', '  ', ' thread-1', 'thread-1 ', 1]) {
      expect(workflowRunMetadataSchema.safeParse({ ...run, threadId }).success).toBe(false);
    }
  });
});
