import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunResponse } from '@dramaflow/contracts';
import { WorkflowRunStatusController } from '../../../src/features/workflow/run/status/workflow-run-status';
import { ApiError } from '../../../src/lib/http';
import { workflowApi } from '../../../src/features/workflow/workflow-api';
import { pendingReview, waitingRun } from '../../fixtures/human-review';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function setup() {
  const get = vi.fn().mockResolvedValue(waitingRun);
  const getPending = vi.fn().mockResolvedValue({ items: [pendingReview] });
  const resume = vi.fn().mockResolvedValue(waitingRun);
  const controller = new WorkflowRunStatusController({ get, getPending, resume });
  controller.watch(waitingRun.id);
  return { controller, get, getPending, resume };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Human Review 同一 Run 状态协调', () => {
  it('刷新观察到 cancelled 后撤下旧审核，旧 token 不能触发 approve / reject', async () => {
    const { controller, get, getPending, resume } = setup();
    await flush();
    expect(controller.getSnapshot().review?.item).toEqual(pendingReview);
    get.mockResolvedValue({
      ...waitingRun,
      status: 'cancelled',
      cancellationRequestedAt: '2026-10-29T00:00:00.000Z',
    });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ run: { status: 'cancelled' }, review: null });
    expect(getPending).toHaveBeenCalledOnce();
    await controller.submit(pendingReview, 'reject');
    await controller.submit(pendingReview, 'approve');
    expect(resume).not.toHaveBeenCalled();
    controller.stop('run-1');
  });
  it('waiting 查询 Pending；pending 等待不启动高频 Run polling', async () => {
    vi.useFakeTimers();
    const { controller, get, getPending } = setup();
    await flush();
    expect(getPending).toHaveBeenCalledExactlyOnceWith('run-1', expect.any(AbortSignal));
    expect(controller.getSnapshot().review?.item).toEqual(pendingReview);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(get).toHaveBeenCalledOnce();
    controller.stop('run-1');
  });

  it.each(['approve', 'reject'] as const)(
    '%s 携带当前目标与可选反馈，阻止同时提交',
    async (action) => {
      const { controller, resume, getPending } = setup();
      await flush();
      controller.setFeedback(pendingReview, '服装需要修改');
      let resolve!: (run: WorkflowRunResponse) => void;
      resume.mockImplementation(
        () =>
          new Promise<WorkflowRunResponse>((done) => {
            resolve = done;
          }),
      );
      const first = controller.submit(pendingReview, action);
      await controller.submit(pendingReview, action);
      controller.setFeedback(pendingReview, '不应覆盖');
      expect(controller.getSnapshot().review).toMatchObject({
        phase: 'submitting',
        feedback: '服装需要修改',
      });
      expect(resume).toHaveBeenCalledExactlyOnceWith('run-1', {
        interruptId: pendingReview.interruptId,
        expectedWaitingRevision: 17,
        value: { action, feedback: '服装需要修改' },
      });
      getPending.mockResolvedValue({
        items: [{ ...pendingReview, submissionStatus: 'submitted' }],
      });
      resolve(waitingRun);
      await first;
      expect(controller.getSnapshot().review?.item.submissionStatus).toBe('submitted');
      await controller.submit(pendingReview, action);
      expect(resume).toHaveBeenCalledOnce();
      controller.stop('run-1');
    },
  );

  it('approve 无反馈省略字段；submitted 沿用 Run timer，running 继续到 completed 结果', async () => {
    vi.useFakeTimers();
    const { controller, get, getPending, resume } = setup();
    await flush();
    getPending.mockResolvedValue({ items: [{ ...pendingReview, submissionStatus: 'submitted' }] });
    await controller.submit(pendingReview, 'approve');
    expect(resume.mock.calls[0]?.[1].value).toEqual({ action: 'approve' });
    expect(get).toHaveBeenCalledTimes(2);
    get
      .mockResolvedValueOnce({ ...waitingRun, status: 'running' })
      .mockResolvedValueOnce({ ...waitingRun, status: 'completed', outputs: {} });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.getSnapshot().run?.status).toBe('running');
    expect(controller.getSnapshot().review).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.getSnapshot().run?.status).toBe('completed');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(get).toHaveBeenCalledTimes(4);
    expect(get.mock.calls.every(([id]) => id === 'run-1')).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('Review1 → submitted → Review2 → completed，旧身份失效且反馈清空', async () => {
    vi.useFakeTimers();
    const { controller, get, getPending, resume } = setup();
    await flush();
    controller.setFeedback(pendingReview, '第一轮反馈');
    getPending.mockResolvedValueOnce({
      items: [{ ...pendingReview, submissionStatus: 'submitted' }],
    });
    await controller.submit(pendingReview, 'approve');
    const second = {
      ...pendingReview,
      interruptId: 'review-2',
      waitingRevision: 18,
      node: { id: 'review-2', name: '第二轮' },
    };
    getPending.mockResolvedValue({ items: [second] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.getSnapshot().review).toMatchObject({ item: second, feedback: '' });
    await controller.submit(pendingReview, 'reject');
    expect(resume).toHaveBeenCalledOnce();
    get.mockResolvedValue({ ...waitingRun, status: 'completed' });
    await controller.submit(second, 'reject');
    expect(resume.mock.calls[1]).toEqual([
      'run-1',
      { interruptId: 'review-2', expectedWaitingRevision: 18, value: { action: 'reject' } },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      runId: 'run-1',
      run: { status: 'completed' },
      review: null,
    });
  });

  it.each([
    new ApiError('stale', 409),
    new TypeError('Failed to fetch'),
    new DOMException('timeout', 'TimeoutError'),
  ])('提交结果错误 %s 只查询 Run/Pending，不自动 replay POST', async (error) => {
    const { controller, get, getPending, resume } = setup();
    await flush();
    resume.mockRejectedValue(error);
    getPending.mockResolvedValue({ items: [{ ...pendingReview, submissionStatus: 'submitted' }] });
    await controller.submit(pendingReview, 'approve');
    expect(get).toHaveBeenCalledTimes(2);
    expect(getPending).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().review).toMatchObject({
      item: { submissionStatus: 'submitted' },
      notice: expect.any(String),
    });
    await controller.submit(pendingReview, 'approve');
    expect(resume).toHaveBeenCalledOnce();
    controller.stop('run-1');
  });

  it('409 换到下一 review 后旧 UI 不能再提交；网络未受理则允许明确再次操作', async () => {
    const { controller, getPending, resume } = setup();
    await flush();
    resume.mockRejectedValueOnce(new ApiError('stale', 409));
    const second = { ...pendingReview, interruptId: 'second', waitingRevision: 18 };
    getPending.mockResolvedValue({ items: [second] });
    await controller.submit(pendingReview, 'approve');
    await controller.submit(pendingReview, 'approve');
    expect(resume).toHaveBeenCalledOnce();
    resume.mockRejectedValueOnce(new TypeError('offline'));
    await controller.submit(second, 'reject');
    expect(resume).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().review).toMatchObject({
      phase: 'ready',
      item: { submissionStatus: 'pending' },
    });
    await controller.submit(second, 'approve');
    expect(resume).toHaveBeenCalledTimes(3);
    controller.stop('run-1');
  });

  it('查询失败或多 pending 不保留旧审批按钮；不猜测 capability', async () => {
    const { controller, getPending, resume } = setup();
    await flush();
    getPending.mockRejectedValueOnce(new ApiError('不支持当前审核拓扑', 422));
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'error',
      review: null,
      error: { message: '不支持当前审核拓扑' },
    });
    await controller.submit(pendingReview, 'approve');
    expect(resume).not.toHaveBeenCalled();
    getPending.mockResolvedValue({
      items: [pendingReview, { ...pendingReview, interruptId: 'second' }],
    });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'error',
      review: null,
      error: { message: '当前暂不支持同时处理多个待审批节点' },
    });
  });

  it('POST 与对账 GET 均失败时撤下旧审批，重新确认 pending 后才允许明确重试', async () => {
    const { controller, get, resume } = setup();
    await flush();
    resume.mockRejectedValueOnce(new TypeError('offline'));
    get.mockRejectedValueOnce(new TypeError('offline'));
    await controller.submit(pendingReview, 'approve');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', review: null });
    await controller.submit(pendingReview, 'approve');
    expect(resume).toHaveBeenCalledOnce();
    await controller.refresh();
    expect(controller.getSnapshot().review?.item.submissionStatus).toBe('pending');
    await controller.submit(pendingReview, 'approve');
    expect(resume).toHaveBeenCalledTimes(2);
    controller.stop('run-1');
  });

  it('旧 pending 请求和晚到 POST 响应不能覆盖已切换的 Run', async () => {
    const { controller, get, getPending, resume } = setup();
    await flush();
    let resolvePending!: (value: { items: (typeof pendingReview)[] }) => void;
    getPending.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
    );
    const refresh = controller.refresh();
    await flush();
    get.mockResolvedValue({ ...waitingRun, id: 'run-2', status: 'completed' });
    controller.watch('run-2');
    resolvePending({ items: [pendingReview] });
    await refresh;
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ runId: 'run-2', review: null });
    get.mockResolvedValue(waitingRun);
    controller.watch('run-1');
    await flush();
    let resolvePost!: (value: WorkflowRunResponse) => void;
    resume.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );
    const post = controller.submit(pendingReview, 'approve');
    get.mockResolvedValue({ ...waitingRun, id: 'run-2', status: 'completed' });
    controller.watch('run-2');
    await flush();
    resolvePost(waitingRun);
    await post;
    expect(controller.getSnapshot()).toMatchObject({
      runId: 'run-2',
      run: { status: 'completed' },
      review: null,
    });
  });
});

describe('Pending / targeted resume Web HTTP 边界', () => {
  it('严格读取 Pending 并 POST 当前 Run 的 decision，不调用 Start', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ items: [pendingReview] }))
      .mockResolvedValueOnce(Response.json(waitingRun, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    expect(await workflowApi.getPendingHumanReviews('run-1')).toEqual({ items: [pendingReview] });
    await workflowApi.resumeRun('run-1', {
      interruptId: pendingReview.interruptId,
      expectedWaitingRevision: 17,
      value: { action: 'reject', feedback: '修改服装' },
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/workflow-runs/run-1/pending-human-reviews',
      '/api/v1/workflow-runs/run-1/resume',
    ]);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      interruptId: pendingReview.interruptId,
      expectedWaitingRevision: 17,
      value: { action: 'reject', feedback: '修改服装' },
    });
  });
  it('不接受不符合 Contract 的 Pending 响应', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ items: [{ ...pendingReview, content: { value: 'text' } }] }),
        ),
    );
    await expect(workflowApi.getPendingHumanReviews('run-1')).rejects.toThrow('服务器响应格式');
  });
});
