import { vi } from 'vitest';
import type { ChildExecution, NodeOccurrence, NodeRun } from '@dramaflow/contracts';
import type {
  CreateNodeRunInput,
  ChildExecutionRepository,
  IterationRunRepository,
  HumanReviewNodeRunRepository,
  NodeRunRepository,
} from '../src/index.js';

// 只作为生命周期调用替身；并发 attempt 与持久化使用 API 的真实 PostgreSQL 测试。
export function nodeRunRepositoryFixture() {
  const occurrences = new Map<string, NodeOccurrence>();
  const getOccurrence = (id: string) => {
    const occurrence = [...occurrences.values()].find((item) => item.id === id);
    if (!occurrence) throw new Error('occurrence 不存在');
    return occurrence;
  };
  return {
    getOccurrence,
    getOrCreateOccurrence: vi
      .fn<NodeRunRepository['getOrCreateOccurrence']>()
      .mockImplementation(async (input) => {
        const key = JSON.stringify([input.workflowRunId, input.scopeKey, input.nodeId]);
        let occurrence = occurrences.get(key);
        if (!occurrence) {
          occurrence = { id: `occurrence-${occurrences.size + 1}`, ...input };
          occurrences.set(key, occurrence);
        }
        return structuredClone(occurrence);
      }),
    createRunning: vi
      .fn<NodeRunRepository['createRunning']>()
      .mockImplementation(async (input) => ({
        id: 'node-run-1',
        workflowRunId: input.workflowRunId,
        nodeId: input.nodeId,
        occurrenceId: input.occurrenceId,
        scopeKey: getOccurrence(input.occurrenceId).scopeKey,
        attempt: 1,
        status: 'running',
        startedAt: '2026-10-20T00:00:00.000Z',
      })),
    updateInputs: vi.fn<NodeRunRepository['updateInputs']>().mockResolvedValue(undefined),
    markCompleted: vi.fn<NodeRunRepository['markCompleted']>().mockResolvedValue(undefined),
    markFailed: vi.fn<NodeRunRepository['markFailed']>().mockResolvedValue(undefined),
  } satisfies NodeRunRepository & { getOccurrence(id: string): NodeOccurrence };
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
      occurrenceId: input.occurrenceId,
      ...(input.childExecutionId ? { childExecutionId: input.childExecutionId } : {}),
      scopeKey: repository.getOccurrence(input.occurrenceId).scopeKey,
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
          .filter((row) => row.occurrenceId === input.occurrenceId)
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
      const rows = [...records.values()].filter((row) => row.occurrenceId === input.occurrenceId);
      const row = rows[0];
      if (row && (rows.length !== 1 || row.status !== 'running' || row.attempt !== 1))
        throw new Error('不能复用审核记录');
      return row ? structuredClone(row) : create(input, 1);
    });
  const items = new Map<string, ChildExecution>();
  const getOrCreateChildExecutionRunning = vi
    .fn<ChildExecutionRepository['getOrCreateChildExecutionRunning']>()
    .mockImplementation(async (input) => {
      const previous = [...items.values()].find(
        (child) =>
          child.parentNodeRunId === input.parentNodeRunId &&
          child.invocationKey === input.invocationKey,
      );
      if (previous) {
        if (previous.status !== 'running' || previous.scopeKey !== input.scopeKey)
          throw new Error('Child 已结束');
        return structuredClone(previous);
      }
      const row: ChildExecution = {
        ...input,
        id: `item-run-${items.size + 1}`,
        status: 'running',
        createdAt: '2026-10-26T00:00:00.000Z',
        startedAt: '2026-10-26T00:00:00.000Z',
      };
      items.set(row.id, row);
      return structuredClone(row);
    });
  const getOrCreateIterationItemRunning = vi
    .fn<IterationRunRepository['getOrCreateIterationItemRunning']>()
    .mockImplementation(async ({ index, ...input }) =>
      getOrCreateChildExecutionRunning({
        ...input,
        kind: 'iteration_item',
        invocationKey: `iteration-item:${index}`,
        metadata: { index },
      }),
    );
  const markIterationItemCompleted = vi
    .fn<IterationRunRepository['markIterationItemCompleted']>()
    .mockImplementation(async (id) => {
      const row = items.get(id);
      if (!row || row.status !== 'running') throw new Error('Item 不是 running');
      row.status = 'completed';
      row.completedAt = '2026-10-26T00:00:02.000Z';
    });
  const markIterationItemFailed = vi
    .fn<IterationRunRepository['markIterationItemFailed']>()
    .mockImplementation(async (id, error) => {
      const row = items.get(id);
      if (!row || row.status === 'completed') throw new Error('Item 不是 running / failed');
      if (row.status === 'running') {
        row.status = 'failed';
        row.error = structuredClone(error);
        row.completedAt = '2026-10-26T00:00:02.000Z';
      }
      const parent = records.get(row.parentNodeRunId)!;
      if (parent.status === 'running') await repository.markFailed(parent.id, error);
    });
  return {
    ...repository,
    getOrCreateChildExecutionRunning,
    getChildExecutionById: vi
      .fn<ChildExecutionRepository['getChildExecutionById']>()
      .mockImplementation(async (id) => structuredClone(items.get(id) ?? null)),
    markChildExecutionCompleted: markIterationItemCompleted,
    markChildExecutionFailed: vi
      .fn<ChildExecutionRepository['markChildExecutionFailed']>()
      .mockImplementation(async (id, error) => {
        const row = items.get(id)!;
        row.status = 'failed';
        row.error = error;
      }),
    getOrCreateIterationItemRunning,
    markIterationItemCompleted,
    markIterationItemFailed,
    getItemRecords: () => structuredClone([...items.values()]),
    getOrCreateHumanReviewRunning,
    getRecords: () => structuredClone([...records.values()]),
  } satisfies HumanReviewNodeRunRepository &
    IterationRunRepository & {
      getItemRecords(): ChildExecution[];
      getRecords(): NodeRun[];
    };
}
