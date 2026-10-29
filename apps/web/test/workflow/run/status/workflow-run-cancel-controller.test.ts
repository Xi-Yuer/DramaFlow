import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CancelWorkflowRunResponse } from '@dramaflow/contracts';
import { WorkflowRunStatusController } from '../../../../src/features/workflow/run/status/workflow-run-status';
import { workflowApi } from '../../../../src/features/workflow/workflow-api';
import { waitingRun } from '../../../fixtures/human-review';
const run = { ...waitingRun, status: 'running' as const, cancellation: 'none' as const };
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture() {
  const get = vi.fn().mockResolvedValue(run);
  const cancel = vi.fn(async (): Promise<CancelWorkflowRunResponse> => ({
    outcome: 'requested',
    run: { ...run, cancellation: 'requested' },
  }));
  const controller = new WorkflowRunStatusController({
    get,
    cancel,
    resume: vi.fn(),
    getPending: vi.fn().mockResolvedValue({ items: [] }),
  });
  controller.watch(run.id);
  return { get, cancel, controller };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('Cancel 复用 Run status controller', () => {
  it('requested → uncertain → cancelled 只使用原有单个 polling timer', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await flush();
    f.get.mockResolvedValue({ ...run, cancellation: 'requested' });
    await f.controller.cancel(run.id);
    expect(f.controller.getSnapshot().run).toMatchObject({
      status: 'running',
      cancellation: 'requested',
    });
    expect(vi.getTimerCount()).toBe(1);
    f.get.mockResolvedValue({ ...run, cancellation: 'uncertain' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.controller.getSnapshot().run?.cancellation).toBe('uncertain');
    expect(vi.getTimerCount()).toBe(1);
    f.get.mockResolvedValue({ ...run, status: 'cancelled', cancellation: 'none' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.controller.getSnapshot().run?.status).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
    expect(f.cancel).toHaveBeenCalledOnce();
  });
  it('重复点击只提交一次；late cancel response 不能覆盖新 Run', async () => {
    const f = fixture();
    await flush();
    let finish!: (value: CancelWorkflowRunResponse) => void;
    f.cancel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const submitting = f.controller.cancel(run.id);
    await f.controller.cancel(run.id);
    expect(f.cancel).toHaveBeenCalledOnce();
    f.get.mockResolvedValue({ ...run, id: 'new-run' });
    f.controller.watch('new-run');
    await flush();
    finish({ outcome: 'cancelled', run: { ...run, status: 'cancelled' } });
    await submitting;
    expect(f.controller.getSnapshot()).toMatchObject({
      runId: 'new-run',
      run: { id: 'new-run', status: 'running' },
      cancelSubmitting: false,
    });
    f.controller.stop('new-run');
  });
  it.each(['completed', 'failed'] as const)(
    'POST requested 后 GET 先观察到 %s，真实结果优先',
    async (status) => {
      const f = fixture();
      await flush();
      f.get.mockResolvedValue({ ...run, status });
      await f.controller.cancel(run.id);
      expect(f.controller.getSnapshot().run?.status).toBe(status);
      expect(f.cancel).toHaveBeenCalledOnce();
      f.controller.stop(run.id);
    },
  );
  it('POST 和 GET 均失败时不重放；手动重新核对前不允许再次取消', async () => {
    const f = fixture();
    await flush();
    f.cancel.mockRejectedValue(new TypeError('offline'));
    f.get.mockRejectedValue(new TypeError('offline'));
    await f.controller.cancel(run.id);
    await f.controller.cancel(run.id);
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      cancelSubmitting: false,
      review: null,
    });
    expect(f.controller.getSnapshot().cancelNotice).toBeTruthy();
    f.get.mockResolvedValue({ ...run, status: 'cancelled' });
    await f.controller.refresh();
    expect(f.controller.getSnapshot()).toMatchObject({
      run: { status: 'cancelled' },
      cancelNotice: null,
    });
    f.controller.stop(run.id);
  });
  it('Cancel HTTP 使用 scoped 路径与空业务 body，不携带执行内部身份', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ outcome: 'requested', run: { ...run, cancellation: 'requested' } }),
      );
    vi.stubGlobal('fetch', fetch);
    await workflowApi.cancelRun('project-id', run.workflowId, run.id);
    expect(fetch.mock.calls[0]![0]).toBe(
      `/api/v1/projects/project-id/workflows/${run.workflowId}/runs/${run.id}/cancel`,
    );
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: '{}' });
  });
});
