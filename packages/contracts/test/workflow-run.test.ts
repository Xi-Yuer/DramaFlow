import { describe, expect, it } from 'vitest';
import { workflowRunSchema, workflowRunStatusSchema } from '../src/index.js';

describe('WorkflowRun 完整运行协议', () => {
  const run = {
    id: 'run-1',
    projectId: 'project-1',
    workflowId: 'workflow-1',
    workflowVersionId: 'version-3',
    invocationKey: 'invocation-1',
    threadId: 'root-thread-1',
    status: 'pending',
    inputs: {},
    createdAt: '2026-10-20T00:00:00.000Z',
  };
  const video = {
    storage: 'reference',
    type: { kind: 'named', name: 'media.video' },
    reference: { kind: 'artifact', id: 'video-artifact' },
  };

  it('六种业务状态包含 waiting，但不增加 NodeRun 状态', () => {
    for (const status of ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'])
      expect(workflowRunSchema.parse({ ...run, status }).status).toBe(status);
    for (const status of ['paused', 'ready', 'retrying'])
      expect(workflowRunStatusSchema.safeParse(status).success).toBe(false);
  });

  it('显式要求项目、工作流、版本与独立 thread，不从业务 ID 推断', () => {
    expect(workflowRunSchema.parse(run).threadId).not.toBe(run.id);
    expect(workflowRunSchema.parse({ ...run, threadId: run.id }).threadId).toBe(run.id);
    for (const key of [
      'id',
      'projectId',
      'workflowId',
      'workflowVersionId',
      'threadId',
      'createdAt',
      'inputs',
    ])
      expect(workflowRunSchema.safeParse({ ...run, [key]: undefined }).success).toBe(false);
    expect(workflowRunSchema.safeParse({ ...run, workflowVersionId: '' }).success).toBe(false);
  });

  it('输入和最终对外输出都是 RuntimeValue map，可 JSON 往返且不共享调用方对象', () => {
    const values = {
      ...run,
      inputs: {
        novel: { storage: 'inline', type: { kind: 'primitive', name: 'string' }, value: '正文' },
      },
      outputs: { movie: video },
    };
    const parsed = workflowRunSchema.parse(JSON.parse(JSON.stringify(values)));
    values.inputs.novel.value = '修改后的草稿';
    expect(parsed.inputs.novel).toMatchObject({ value: '正文' });
    expect(parsed.outputs).toEqual({ movie: video });
    for (const outputs of [
      { video: 'raw-url' },
      { nodeId: { video } },
      { video: new Uint8Array([1, 2]) },
    ])
      expect(workflowRunSchema.safeParse({ ...run, outputs }).success).toBe(false);
  });

  it('时间使用 ISO 字符串，错误只接受稳定摘要', () => {
    const error = { stage: 'invoke', message: '图运行失败' };
    expect(workflowRunSchema.parse({ ...run, error }).error).toEqual(error);
    for (const invalid of [
      { ...run, createdAt: new Date() },
      { ...run, startedAt: 'yesterday' },
      { ...run, completedAt: new Date() },
      { ...run, error: new Error('原始异常') },
      { ...run, error: { ...error, stage: '' } },
      { ...run, error: { ...error, stack: 'internal' } },
      { ...run, definition: {} },
    ])
      expect(workflowRunSchema.safeParse(invalid).success).toBe(false);
  });
});
