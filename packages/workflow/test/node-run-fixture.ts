import { vi } from 'vitest';
import type { NodeRun } from '@dramaflow/contracts';
import type {
  CreateNodeRunInput,
  HumanReviewNodeRunRepository,
  NodeRunRepository,
} from '../src/index.js';

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

// 仅用于真实 Graph 的内存审计断言；SQL 锁 / 权限边界由隔离 PostgreSQL 测试证明。
export function auditedNodeRunRepositoryFixture() {
  const repository = nodeRunRepositoryFixture();
  const records = new Map<string, NodeRun>();
  let sequence = 0;
  function create(input: CreateNodeRunInput, attempt: number) {
    const row = {
      id: `node-run-${++sequence}`,
      workflowRunId: input.workflowRunId,
      nodeId: input.nodeId,
      attempt,
      status: 'running' as const,
      startedAt: '2026-10-20T00:00:00.000Z',
    };
    records.set(row.id, row);
    return structuredClone(row);
  }
  const running = (id: string) => {
    const row = records.get(id);
    if (!row || row.status !== 'running') throw new Error('记录不是 running');
    return row;
  };
  repository.createRunning.mockImplementation(async (input) =>
    create(
      input,
      Math.max(
        0,
        ...[...records.values()]
          .filter((row) => row.workflowRunId === input.workflowRunId && row.nodeId === input.nodeId)
          .map((row) => row.attempt),
      ) + 1,
    ),
  );
  repository.updateInputs.mockImplementation(async (id, inputs) => {
    const row = running(id);
    if (row.inputs !== undefined) throw new Error('inputs 已记录');
    row.inputs = structuredClone(inputs);
  });
  repository.markCompleted.mockImplementation(async (id, outputs) => {
    const row = running(id);
    if (row.inputs === undefined) throw new Error('inputs 未记录');
    row.outputs = structuredClone(outputs);
    row.status = 'completed';
    row.completedAt = '2026-10-20T00:00:02.000Z';
  });
  repository.markFailed.mockImplementation(async (id, error) => {
    const row = running(id);
    row.error = structuredClone(error);
    row.status = 'failed';
    row.completedAt = '2026-10-20T00:00:02.000Z';
  });
  const getOrCreateHumanReviewRunning = vi
    .fn<HumanReviewNodeRunRepository['getOrCreateHumanReviewRunning']>()
    .mockImplementation(async (input) => {
      const rows = [...records.values()].filter(
        (row) => row.workflowRunId === input.workflowRunId && row.nodeId === input.nodeId,
      );
      const row = rows[0];
      if (row && (rows.length !== 1 || row.status !== 'running' || row.attempt !== 1))
        throw new Error('不能复用审核记录');
      return row ? structuredClone(row) : create(input, 1);
    });
  return {
    ...repository,
    getOrCreateHumanReviewRunning,
    getRecords: () => structuredClone([...records.values()]),
  } satisfies HumanReviewNodeRunRepository & {
    getRecords(): NodeRun[];
  };
}
