import { describe, expect, it } from 'vitest';
import {
  resumeWorkflowRunRequestSchema,
  startWorkflowRunRequestSchema,
  workflowRunResponseSchema,
  pendingHumanReviewsResponseSchema,
} from '../src/index.js';

describe('Workflow Run HTTP 契约', () => {
  it('start 接收明确版本、调用 key 及 RuntimeValue inputs，拒绝指定执行身份和状态', () => {
    const request = { workflowVersionId: 'version-1', invocationKey: 'invocation-1', inputs: {} };
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

  it('invocationKey 必填、非空、保留原值且有长度上限', () => {
    const request = { workflowVersionId: 'version-1', inputs: {} };
    for (const invocationKey of [undefined, '', ' leading', 'trailing ', 'x'.repeat(201)])
      expect(startWorkflowRunRequestSchema.safeParse({ ...request, invocationKey }).success).toBe(
        false,
      );
    expect(
      startWorkflowRunRequestSchema.parse({ ...request, invocationKey: 'call-A_1' }).invocationKey,
    ).toBe('call-A_1');
  });

  it('Human Review resume 要求明确 token / revision / 正式 decision，拒绝裸 value', () => {
    const target = { interruptId: 'opaque:token', expectedWaitingRevision: 1 };
    for (const value of [
      { action: 'approve' },
      { action: 'reject' },
      { action: 'reject', feedback: '修改意见' },
    ])
      expect(resumeWorkflowRunRequestSchema.parse({ ...target, value })).toEqual({
        ...target,
        value,
      });
    for (const input of [
      { value: { action: 'approve' } },
      { ...target, value: null },
      { ...target, value: { action: 'comment' } },
      { ...target, value: { action: 'approve', approved: true } },
      { ...target, interruptId: '', value: { action: 'approve' } },
      { ...target, expectedWaitingRevision: 0, value: { action: 'approve' } },
      { ...target, value: { action: 'reject', feedback: 2 } },
      { ...target, value: { action: 'approve' }, threadId: 'private' },
    ])
      expect(resumeWorkflowRunRequestSchema.safeParse(input).success).toBe(false);
  });
  it('Pending 仅返回产品字段，内容为文本，无 LangGraph / NodeRun internals', () => {
    const item = {
      interruptId: 'opaque',
      waitingRevision: 1,
      node: { id: 'R', name: '审核' },
      content: '原文',
      submissionStatus: 'pending',
    };
    expect(pendingHumanReviewsResponseSchema.parse({ items: [item] })).toEqual({ items: [item] });
    for (const key of ['threadId', 'checkpoint_ns', 'tasks', 'nodeRunId', 'definition'])
      expect(
        pendingHumanReviewsResponseSchema.safeParse({ items: [{ ...item, [key]: 'private' }] })
          .success,
      ).toBe(false);
    expect(
      pendingHumanReviewsResponseSchema.safeParse({
        items: [{ ...item, content: { storage: 'inline', value: 'private' } }],
      }).success,
    ).toBe(false);
  });

  it('所有状态可使用同一响应协议，不公开项目 / thread，错误仅保留稳定摘要', () => {
    const response = {
      id: 'run',
      workflowId: 'workflow',
      workflowVersionId: 'version',
      invocationKey: 'invocation-1',
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
