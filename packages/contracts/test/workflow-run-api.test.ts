import { describe, expect, it } from 'vitest';
import {
  resumeWorkflowRunRequestSchema,
  startWorkflowRunRequestSchema,
  workflowRunResponseSchema,
} from '../src/index.js';

describe('Workflow Run HTTP 契约', () => {
  it('start 只接受明确版本及 RuntimeValue inputs，拒绝调用方指定执行身份和状态', () => {
    const request = { workflowVersionId: 'version-1', inputs: {} };
    expect(startWorkflowRunRequestSchema.parse(request)).toEqual(request);
    for (const key of ['threadId', 'status', 'workflowId', 'projectId', 'definition', 'ownerId'])
      expect(
        startWorkflowRunRequestSchema.safeParse({ ...request, [key]: 'injected' }).success,
      ).toBe(false);
    expect(
      startWorkflowRunRequestSchema.safeParse({ workflowVersionId: 'version-1' }).success,
    ).toBe(false);
    expect(
      startWorkflowRunRequestSchema.safeParse({ ...request, inputs: { prompt: 'raw' } }).success,
    ).toBe(false);
  });

  it('resume 必须显式提供 value，允许 falsy / null / 对象，不允许覆盖 thread 或版本', () => {
    for (const value of [false, 0, '', null, { decision: 'approve' }, [1, 2]])
      expect(resumeWorkflowRunRequestSchema.parse({ value })).toEqual({ value });
    for (const value of [
      {},
      { value: undefined },
      { value: 1, threadId: 'other' },
      { value: 1, workflowVersionId: 'other' },
    ])
      expect(resumeWorkflowRunRequestSchema.safeParse(value).success).toBe(false);
  });

  it('所有状态可使用同一响应协议，不公开项目 / thread，错误仅保留稳定摘要', () => {
    const response = {
      id: 'run',
      workflowId: 'workflow',
      workflowVersionId: 'version',
      status: 'completed',
      inputs: {},
      outputs: {},
      createdAt: '2026-10-20T00:00:00.000Z',
    };
    expect(workflowRunResponseSchema.parse(response)).toEqual(response);
    for (const key of ['threadId', 'projectId', 'state', 'checkpoint', 'cause', 'stack'])
      expect(workflowRunResponseSchema.safeParse({ ...response, [key]: 'private' }).success).toBe(
        false,
      );
    expect(
      workflowRunResponseSchema.safeParse({
        ...response,
        error: { stage: 'execute', message: '失败', cause: {} },
      }).success,
    ).toBe(false);
    for (const status of ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'])
      expect(workflowRunResponseSchema.parse({ ...response, status }).status).toBe(status);
  });
});
