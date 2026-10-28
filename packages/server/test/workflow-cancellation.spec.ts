import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@dramaflow/database';
import { WorkflowRunNotPendingError } from '@dramaflow/workflow';
import { WorkflowExecutionService } from '../src/workflow/runtime/workflow-execution.service.js';
import type { WorkflowRuntimeFactory } from '../src/workflow/runtime/workflow-runtime.factory.js';
import type { DatabaseService } from '../src/database/database.service.js';

function fixture(status: string, requested: boolean) {
  const job = { kind: 'start' as const, workflowRunId: 'run' };
  const intent = {
    id: 'intent',
    status,
    waitingRevision: 0,
    payload: job,
    workflowRun: {
      id: 'run',
      projectId: 'project',
      status: 'pending',
      waitingRevision: 0,
      cancellationRequestedAt: requested ? new Date() : null,
      project: { ownerId: 'owner' },
    },
  };
  const findFirst = vi.fn(async () => intent);
  const findUniqueOrThrow = vi.fn(async () => intent);
  const updateMany = vi.fn(async (_query: Prisma.WorkflowExecutionOutboxUpdateManyArgs) => ({
    count: 1,
  }));
  const executeStart = vi.fn(async () => ({ status: 'completed' }));
  const forProject = vi.fn(async () => ({ executeStart }));
  const service = new WorkflowExecutionService(
    {
      client: { workflowExecutionOutbox: { findFirst, findUniqueOrThrow, updateMany } },
    } as unknown as DatabaseService,
    { forProject } as unknown as WorkflowRuntimeFactory,
  );
  return { service, job, intent, forProject, executeStart, updateMany };
}

describe('Worker cancellation 请求与执行结果边界', () => {
  it('取消的命令是正常结算，不构造 Runtime、不写 failed/recovery_required', async () => {
    const f = fixture('cancelled', true);
    expect(await f.service.execute(f.job)).toMatchObject({ status: 'execution_cancelled' });
    expect(f.forProject).not.toHaveBeenCalled();
    expect(f.updateMany).not.toHaveBeenCalled();
  });
  it.each(['pending', 'published'])('%s 意图遇到请求只结算尚未 claim 的命令', async (status) => {
    const f = fixture(status, true);
    expect(await f.service.execute(f.job)).toMatchObject({ status: 'cancellation_requested' });
    expect(f.forProject).not.toHaveBeenCalled();
    expect(f.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['pending', 'published'] },
          workflowRun: expect.any(Object),
        }),
        data: { status: 'cancelled', completedAt: expect.any(Date) },
      }),
    );
  });
  it('取消结算写入失败原样上抛，不伪造取消成功', async () => {
    const f = fixture('published', true);
    const error = new Error('persistence unavailable');
    f.updateMany.mockRejectedValue(error);
    await expect(f.service.execute(f.job)).rejects.toBe(error);
    expect(f.executeStart).not.toHaveBeenCalled();
  });
  it('claim 拒绝时重新读取取消事实，executing 不被该处理改成 cancelled', async () => {
    const f = fixture('published', false);
    f.executeStart.mockImplementation(async () => {
      f.intent.workflowRun.status = 'running';
      f.intent.workflowRun.cancellationRequestedAt = new Date();
      f.intent.status = 'executing';
      throw new WorkflowRunNotPendingError('run');
    });
    expect(await f.service.execute(f.job)).toMatchObject({ status: 'cancellation_requested' });
    expect(f.updateMany).toHaveBeenCalledTimes(1);
    expect(f.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { status: { in: ['pending', 'published'] } },
    });
  });
  it.each(['completed', 'failed'])('在途 %s 事实优先于取消请求，不误报已取消', async (status) => {
    const f = fixture('published', false);
    f.executeStart.mockImplementation(async () => {
      f.intent.status = 'executing';
      f.intent.workflowRun.status = status;
      f.intent.workflowRun.cancellationRequestedAt = new Date();
      throw new WorkflowRunNotPendingError('run');
    });
    if (status === 'failed')
      await expect(f.service.execute(f.job)).rejects.toMatchObject({
        code: 'WORKFLOW_EXECUTION_FAILED',
      });
    else expect(await f.service.execute(f.job)).toMatchObject({ status: 'already_processed' });
    expect(f.updateMany.mock.calls[0]![0].data.status).toBe(status);
  });
  it('取消请求不吞掉既有 recovery_required', async () => {
    const f = fixture('recovery_required', true);
    await expect(f.service.execute(f.job)).rejects.toMatchObject({
      code: 'WORKFLOW_EXECUTION_RECOVERY_REQUIRED',
    });
    expect(f.forProject).not.toHaveBeenCalled();
    expect(f.updateMany).not.toHaveBeenCalled();
  });
});
