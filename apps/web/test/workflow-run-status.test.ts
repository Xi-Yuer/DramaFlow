import { StringType, type WorkflowRunResponse, type WorkflowRunStatus } from '@dramaflow/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingReview } from './fixtures/human-review';
import { workflowApi } from '../src/features/workflow/workflow-api';
import {
  WorkflowRunStatusController,
  workflowRunTrackingId,
} from '../src/features/workflow/run/status/workflow-run-status';

function run(
  id: string,
  status: WorkflowRunStatus,
  extra: Partial<WorkflowRunResponse> = {},
): WorkflowRunResponse {
  return {
    id,
    workflowId: 'workflow-1',
    workflowVersionId: 'version-3',
    invocationKey: `invocation-${id}`,
    status,
    inputs: {
      prompt: { storage: 'inline', type: StringType, value: '不会展示的输入' },
    },
    createdAt: '2026-10-22T01:00:00.000Z',
    ...extra,
  };
}

function statusController(
  get: (runId: string, signal: AbortSignal) => Promise<WorkflowRunResponse>,
) {
  return new WorkflowRunStatusController({
    get,
    getPending: vi.fn().mockResolvedValue({ items: [pendingReview] }),
    resume: vi.fn(),
  });
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WorkflowRunStatusController', () => {
  it('accepted 后按 WorkflowRun.id 查询，响应与查询均不依赖 threadId', async () => {
    const get = vi.fn().mockResolvedValue(run('run-1', 'completed'));
    const controller = statusController(get);
    controller.watch('run-1');
    await flush();
    expect(get).toHaveBeenCalledExactlyOnceWith('run-1', expect.any(AbortSignal));
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      runId: 'run-1',
      run: {
        id: 'run-1',
        workflowVersionId: 'version-3',
        status: 'completed',
      },
    });
    expect(controller.getSnapshot().run).not.toHaveProperty('threadId');
  });

  it.each(['pending', 'running'] as const)(
    '%s 每 2 秒继续 polling，且不会累积 timer',
    async (status) => {
      vi.useFakeTimers();
      const get = vi.fn().mockResolvedValue(run('run-1', status));
      const controller = statusController(get);
      controller.watch('run-1');
      await flush();
      expect(get).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(get).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(get).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(get).toHaveBeenCalledTimes(3);
    },
  );

  it.each(['waiting', 'completed', 'failed', 'cancelled'] as const)(
    '%s 停止普通 polling',
    async (status) => {
      vi.useFakeTimers();
      const get = vi.fn().mockResolvedValue(run('run-1', status));
      const controller = statusController(get);
      controller.watch('run-1');
      await flush();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(get).toHaveBeenCalledOnce();
    },
  );

  it('切换 Run 取消旧 polling 和旧请求，旧结果不能覆盖新 Run', async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: WorkflowRunResponse) => void;
    let resolveNew!: (value: WorkflowRunResponse) => void;
    const signals: AbortSignal[] = [];
    const get = vi.fn((id: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<WorkflowRunResponse>((resolve) => {
        if (id === 'run-old') resolveOld = resolve;
        else resolveNew = resolve;
      });
    });
    const controller = statusController(get);
    controller.watch('run-old');
    controller.watch('run-new');
    expect(signals[0]?.aborted).toBe(true);
    resolveNew(run('run-new', 'completed'));
    await flush();
    resolveOld(run('run-old', 'running'));
    await flush();
    expect(controller.getSnapshot()).toMatchObject({
      runId: 'run-new',
      run: { id: 'run-new', status: 'completed' },
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('unmount/stop 取消请求和 timer，不再 polling', async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockResolvedValue(run('run-1', 'pending'));
    const controller = statusController(get);
    controller.watch('run-1');
    await flush();
    controller.stop('run-1');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', runId: null });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(get).toHaveBeenCalledOnce();
  });

  it('手动 refresh 即使在终态也立即重新查询', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(run('run-1', 'completed'))
      .mockResolvedValueOnce(
        run('run-1', 'completed', {
          completedAt: '2026-10-22T01:01:00.000Z',
        }),
      );
    const controller = statusController(get);
    controller.watch('run-1');
    await flush();
    await controller.refresh();
    expect(get).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().run?.completedAt).toBe('2026-10-22T01:01:00.000Z');
  });
});

describe('Start identity 到 Run Status 跟踪入口', () => {
  it('accepted 使用 accepted Run ID；queue confirmation error 保持 Start error 但仍可查询', () => {
    expect(
      workflowRunTrackingId({
        phase: 'accepted',
        request: null,
        accepted: {
          id: 'run-accepted',
          workflowVersionId: 'version-1',
          invocationKey: 'invocation-1',
          status: 'pending',
        },
        error: null,
      }),
    ).toBe('run-accepted');
    const startError = {
      phase: 'error' as const,
      request: null,
      accepted: null,
      error: {
        message: '入队结果未确认',
        status: 503,
        workflowRunId: 'run-persisted',
        invocationKey: 'invocation-2',
      },
    };
    expect(workflowRunTrackingId(startError)).toBe('run-persisted');
    expect(startError.phase).toBe('error');
  });
});

describe('GET WorkflowRun HTTP', () => {
  it('按 Run ID 查询现有安全响应 Contract', async () => {
    const response = run('run-1', 'failed', {
      startedAt: '2026-10-22T01:00:02.000Z',
      completedAt: '2026-10-22T01:00:05.000Z',
      error: { stage: 'invoke', code: 'GRAPH_FAILED', message: '图运行失败' },
    });
    const fetch = vi.fn().mockResolvedValue(Response.json(response));
    vi.stubGlobal('fetch', fetch);
    expect(await workflowApi.getRun('run-1')).toEqual(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/workflow-runs/run-1',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });
});
