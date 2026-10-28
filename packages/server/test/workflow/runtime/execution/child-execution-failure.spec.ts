import { randomUUID } from 'node:crypto';
import type { Prisma } from '@dramaflow/database';
import type { NodeRunError } from '@dramaflow/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../../src/database/database.service.js';
import { ChildExecutionRepository } from '../../../../src/workflow/runtime/execution/children/child-execution-repository.js';

type Lifecycle = { status: string; error?: NodeRunError; completedAt?: Date };
function fixture(kind = 'subworkflow') {
  const scope = { projectId: randomUUID(), workflowRunId: 'run', ownerId: randomUUID() };
  const child = {
    id: randomUUID(),
    parentNodeRunId: randomUUID(),
    kind,
    status: 'running',
  } as Lifecycle & {
    id: string;
    parentNodeRunId: string;
    kind: string;
  };
  const parent: Lifecycle = { status: 'running' };
  const update = (
    row: Lifecycle,
    request: { where: { status?: string }; data: Partial<Lifecycle> },
  ) => {
    if (request.where.status !== row.status) return { count: 0 };
    Object.assign(row, request.data);
    return { count: 1 };
  };
  const tx = {
    childExecution: {
      findFirst: vi.fn(async () =>
        ['running', 'failed'].includes(child.status) ? { ...child } : null,
      ),
      updateMany: vi.fn(async (request: { where: { status?: string }; data: Partial<Lifecycle> }) =>
        update(child, request),
      ),
    },
    nodeRun: {
      updateMany: vi.fn(async (request: { where: { status?: string }; data: Partial<Lifecycle> }) =>
        update(parent, request),
      ),
    },
  };
  const transaction = vi.fn(async (write: (tx: Prisma.TransactionClient) => Promise<void>) =>
    write(tx as unknown as Prisma.TransactionClient),
  );
  const database = { client: { $transaction: transaction } } as unknown as DatabaseService;
  return {
    child,
    parent,
    tx,
    scope,
    transaction,
    repository: new ChildExecutionRepository(database, scope),
  };
}
const first: NodeRunError = { stage: 'execute', message: 'first failure' };
const later: NodeRunError = { stage: 'validate_output', message: 'later failure' };

describe('Composite owner 仓储失败生命周期', () => {
  it.each(['subworkflow', 'iteration_item'])(
    '%s 只结束显式 child 与直接父 attempt，重复失败保留首个终态',
    async (kind) => {
      const f = fixture(kind);
      const fail =
        kind === 'iteration_item'
          ? f.repository.markIterationItemFailed.bind(f.repository)
          : f.repository.markChildExecutionAndParentFailed.bind(f.repository);
      await fail(f.child.id, first);
      const ended = structuredClone({ child: f.child, parent: f.parent });
      await fail(f.child.id, later);
      expect({ child: f.child, parent: f.parent }).toEqual(ended);
      expect(f.child.status).toBe('failed');
      expect(f.parent.status).toBe('failed');
      expect(f.tx.childExecution.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: f.child.id,
          workflowRunId: f.scope.workflowRunId,
          projectId: f.scope.projectId,
          status: 'running',
        }),
        data: expect.objectContaining({ status: 'failed', error: first }),
      });
      expect(f.tx.nodeRun.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: f.child.parentNodeRunId,
          workflowRunId: f.scope.workflowRunId,
          projectId: f.scope.projectId,
          status: 'running',
        }),
        data: expect.objectContaining({ status: 'failed', error: first }),
      });
      expect(f.transaction).toHaveBeenCalledTimes(2);
    },
  );

  it('completed child / parent 拒绝失败转换，不触发任何写入', async () => {
    const f = fixture();
    f.child.status = 'completed';
    f.parent.status = 'completed';
    await expect(
      f.repository.markChildExecutionAndParentFailed(f.child.id, first),
    ).rejects.toThrow();
    expect(f.tx.childExecution.updateMany).not.toHaveBeenCalled();
    expect(f.tx.nodeRun.updateMany).not.toHaveBeenCalled();
    expect(f.child.status).toBe('completed');
    expect(f.parent.status).toBe('completed');
  });

  it('直接父 attempt 已结束时不覆盖其 completed 状态', async () => {
    const f = fixture();
    f.parent.status = 'completed';
    await f.repository.markChildExecutionAndParentFailed(f.child.id, first);
    expect(f.parent).toEqual({ status: 'completed' });
  });

  it('仓储写入失败原样上抛，不继续宣称 Parent failed', async () => {
    const f = fixture();
    const cause = new Error('database unavailable');
    f.tx.childExecution.updateMany.mockRejectedValue(cause);
    await expect(f.repository.markChildExecutionAndParentFailed(f.child.id, first)).rejects.toBe(
      cause,
    );
    expect(f.tx.nodeRun.updateMany).not.toHaveBeenCalled();
    expect(f.child.status).toBe('running');
    expect(f.parent.status).toBe('running');
  });

  it('Iteration owner helper 继续拒绝其他 kind，不转换别人 lifecycle', async () => {
    const f = fixture();
    await expect(f.repository.markIterationItemFailed(f.child.id, first)).rejects.toThrow(
      'Iteration helper 不接受其他 ChildExecution kind',
    );
    expect(f.tx.childExecution.updateMany).not.toHaveBeenCalled();
    expect(f.tx.nodeRun.updateMany).not.toHaveBeenCalled();
  });
});
