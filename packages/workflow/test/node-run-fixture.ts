import { vi } from 'vitest';
import type { NodeRunRepository } from '../src/index.js';

// 只作为生命周期调用替身；并发 attempt 与持久化使用 API 的真实 PostgreSQL 测试。
export function nodeRunRepositoryFixture() {
  return {
    createRunning: vi
      .fn<NodeRunRepository['createRunning']>()
      .mockImplementation(async (input) => ({
        id: 'node-run-1',
        workflowRunId: input.workflowRunId,
        nodeId: input.nodeId,
        attempt: 1,
        status: 'running',
        startedAt: '2026-10-20T00:00:00.000Z',
      })),
    updateInputs: vi.fn<NodeRunRepository['updateInputs']>().mockResolvedValue(undefined),
    markCompleted: vi.fn<NodeRunRepository['markCompleted']>().mockResolvedValue(undefined),
    markFailed: vi.fn<NodeRunRepository['markFailed']>().mockResolvedValue(undefined),
  } satisfies NodeRunRepository;
}
