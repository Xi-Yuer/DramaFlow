import { describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionCancellation } from '@dramaflow/workflow';
import { observeWorkflowCancellation } from '../../../../src/workflow/runtime/cancellation/observe-cancellation.js';
import type { DatabaseService } from '../../../../src/database/database.service.js';

describe('Worker 持久化意图观察', () => {
  it('读取其他进程提交的取消事实，查询故障后继续观察，停止后不再请求', async () => {
    vi.useFakeTimers();
    const findUnique = vi
      .fn()
      .mockRejectedValueOnce(Error('temporary DB failure'))
      .mockResolvedValueOnce({ cancellationRequestedAt: null })
      .mockResolvedValue({ cancellationRequestedAt: new Date() });
    const scope = new WorkflowExecutionCancellation('run');
    const stop = observeWorkflowCancellation(
      { client: { workflowRun: { findUnique } } } as unknown as DatabaseService,
      scope,
      50,
    );
    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(scope.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
      expect(scope.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
      expect(scope.signal.aborted).toBe(true);
      await stop();
      await vi.advanceTimersByTimeAsync(500);
      expect(findUnique).toHaveBeenCalledTimes(3);
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: 'run' },
        select: { cancellationRequestedAt: true },
      });
    } finally {
      await stop();
      vi.useRealTimers();
    }
  });
});
