import { describe, expect, it, vi } from 'vitest';
import {
  workflowExecutionJobId,
  isRetryableWorkflowInfrastructureError,
  WorkflowExecutionService,
  type WorkflowRuntimeFactory,
  type DatabaseService,
} from '../../../src/index.js';

describe('执行命令身份与基础设施错误分类', () => {
  it('同一领域意图稳定，不同恢复意图不同，身份不包含冒号或业务值', () => {
    const start = { kind: 'start' as const, workflowRunId: 'run:with/separators' };
    expect(workflowExecutionJobId(start)).toBe(workflowExecutionJobId(structuredClone(start)));
    expect(workflowExecutionJobId(start)).not.toContain(':');
    const first = {
      kind: 'resume' as const,
      workflowRunId: start.workflowRunId,
      executionId: 'intent-1',
      value: 'secret payload',
    };
    expect(workflowExecutionJobId(first)).toBe(
      workflowExecutionJobId({ ...first, value: 'other value' }),
    );
    expect(workflowExecutionJobId(first)).not.toBe(
      workflowExecutionJobId({ ...first, executionId: 'intent-2' }),
    );
    expect(workflowExecutionJobId(first)).not.toContain('secret');
  });
  it('只允许识别的基础设施错误自动重试，不根据任意业务文本重试', () => {
    for (const code of ['P1001', 'P2024', 'P2034', 'ECONNRESET'])
      expect(
        isRetryableWorkflowInfrastructureError(Object.assign(new Error('private'), { code })),
      ).toBe(true);
    for (const error of [
      new Error('ECONNRESET'),
      Object.assign(new Error('business'), { code: 'NODE_EXECUTION_FAILED' }),
      null,
      'P1001',
    ])
      expect(isRetryableWorkflowInfrastructureError(error)).toBe(false);
  });
});

describe('Worker 只使用匹配持久化意图的 targeted resume', () => {
  function fixture(
    value: unknown = {
      kind: 'targeted_interrupt',
      interruptId: 'review-token',
      value: { action: 'reject', feedback: '修改意见' },
    },
  ) {
    const job = { kind: 'resume' as const, workflowRunId: 'run', executionId: 'intent', value };
    const intent = {
      id: 'intent',
      status: 'published',
      waitingRevision: 1,
      payload: job,
      workflowRun: {
        id: 'run',
        projectId: 'project',
        status: 'waiting',
        waitingRevision: 1,
        project: { ownerId: 'owner' },
      },
    };
    const db = {
      client: {
        workflowExecutionOutbox: {
          findFirst: vi.fn(async () => intent),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
      },
    };
    const runner = { executeResume: vi.fn(async () => ({ status: 'completed' })) };
    const runtime = { forProject: vi.fn(async () => runner) };
    return {
      job,
      runner,
      runtime,
      service: new WorkflowExecutionService(
        db as unknown as DatabaseService,
        runtime as unknown as WorkflowRuntimeFactory,
      ),
    };
  }
  it('持久化 envelope 解包为目标 token 和原决策，Runner 不解释业务字段', async () => {
    const f = fixture();
    await f.service.execute(f.job);
    expect(f.runner.executeResume).toHaveBeenCalledExactlyOnceWith({
      workflowRunId: 'run',
      interruptId: 'review-token',
      value: { action: 'reject', feedback: '修改意见' },
    });
    expect(f.runtime.forProject).toHaveBeenCalledWith('owner', 'project', 'intent');
  });
  it('Job 目标被改写时与 Outbox 不一致，在构造 Runner 前拒绝', async () => {
    const f = fixture();
    await expect(
      f.service.execute({
        ...f.job,
        value: { kind: 'targeted_interrupt', interruptId: 'forged', value: { action: 'approve' } },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_EXECUTION_INTENT_INVALID' });
    expect(f.runtime.forProject).not.toHaveBeenCalled();
  });
  it('内部 targeted envelope 损坏时不能降级为裸 value 恢复', async () => {
    const f = fixture({ kind: 'targeted_interrupt', value: { action: 'approve' } });
    await expect(f.service.execute(f.job)).rejects.toMatchObject({
      code: 'WORKFLOW_EXECUTION_INTENT_INVALID',
    });
    expect(f.runtime.forProject).not.toHaveBeenCalled();
  });
});
