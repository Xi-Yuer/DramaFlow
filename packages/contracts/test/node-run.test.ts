import { describe, expect, it } from 'vitest';
import { nodeRunSchema, nodeRunStatusSchema } from '../src/index.js';

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

  it('保存结构化阶段错误与 ISO 时间，拒绝原始异常、空阶段和业务快照', () => {
    const error = { code: 'NODE_EXECUTION_FAILED', message: '业务执行失败', stage: 'execute' };
    expect(nodeRunSchema.parse({ ...run, status: 'failed', error }).error).toEqual(error);
    for (const value of [
      { ...run, error: new Error('原始错误') },
      { ...run, error: { ...error, stage: '' } },
      { ...run, inputs: { result: '原始字符串' } },
      { ...run, outputs: { result: new Map() } },
      { ...run, outputs: { video: new Uint8Array([1, 2]) } },
      { ...run, startedAt: new Date() },
      { ...run, inputSnapshot: {} },
      { ...run, outputSnapshot: {} },
    ])
      expect(nodeRunSchema.safeParse(value).success).toBe(false);
  });

  it('错误阶段为可扩展字符串，code 可省略，协议可按 JSON 往返', () => {
    const record = {
      ...run,
      status: 'failed',
      error: { stage: 'provider_request', message: '请求未完成' },
    };
    expect(nodeRunSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(nodeRunSchema.parse(record).error).not.toHaveProperty('code');
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
