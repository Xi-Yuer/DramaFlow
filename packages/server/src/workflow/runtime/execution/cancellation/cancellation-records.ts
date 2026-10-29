import type { Prisma } from '@dramaflow/database';
import { WorkflowExecutionCancelled } from '@dramaflow/workflow';
import { NotFoundException } from '@nestjs/common';
import type { DatabaseService } from '../../../../database/database.service.js';
import {
  assertChanged,
  runningChild,
  runningNodeRun,
  type RepositoryScope,
} from '../repository-scope.js';

export async function assertCancellationGate(
  tx: Prisma.TransactionClient,
  scope: RepositoryScope,
): Promise<void> {
  // 与取消请求 / Run 终结锁同一行，不能在取消完成之后提交新的执行记录。
  await tx.$queryRaw`SELECT "id" FROM "workflow_run" WHERE "id" = ${scope.workflowRunId} FOR UPDATE`;
  const run = await tx.workflowRun.findFirst({
    where: {
      id: scope.workflowRunId,
      projectId: scope.projectId,
      project: { ownerId: scope.ownerId },
    },
    select: { status: true, cancellationRequestedAt: true },
  });
  if (!run) throw new NotFoundException('运行不存在或无权访问');
  if (run.cancellationRequestedAt || run.status === 'cancelled') {
    scope.cancellation?.request();
    throw new WorkflowExecutionCancelled(scope.workflowRunId);
  }
}

export function ownExecutionRecord<T extends { id: string }>(
  scope: RepositoryScope,
  kind: 'node' | 'child',
  create: () => Promise<T>,
  cancel: (id: string) => Promise<void>,
): Promise<T> {
  return scope.cancellation
    ? scope.cancellation.own(create, (row) => ({
        key: `${kind}:${row.id}`,
        cancel: () => cancel(row.id),
      }))
    : create();
}

export async function cancelOwnedNode(
  db: DatabaseService,
  scope: RepositoryScope,
  id: string,
): Promise<void> {
  const changed = await db.client.nodeRun.updateMany({
    where: {
      ...runningNodeRun(scope, id),
      workflowRun: { cancellationRequestedAt: { not: null } },
    },
    data: { status: 'cancelled', completedAt: new Date() },
  });
  if (changed.count) return;
  const row = await db.client.nodeRun.findFirst({
    where: { ...runningNodeRun(scope, id), status: { in: ['completed', 'failed', 'cancelled'] } },
    select: { id: true },
  });
  if (!row) assertChanged(0);
}
export async function cancelOwnedChild(
  db: DatabaseService,
  scope: RepositoryScope,
  id: string,
): Promise<void> {
  const changed = await db.client.childExecution.updateMany({
    where: {
      ...runningChild(scope, id),
      workflowRun: { project: { ownerId: scope.ownerId }, cancellationRequestedAt: { not: null } },
    },
    data: { status: 'cancelled', completedAt: new Date() },
  });
  if (changed.count) return;
  const row = await db.client.childExecution.findFirst({
    where: { ...runningChild(scope, id), status: { in: ['completed', 'failed', 'cancelled'] } },
    select: { id: true },
  });
  if (!row) assertChanged(0);
}

export async function assertExecutionWrite(
  db: DatabaseService,
  scope: RepositoryScope,
  kind: 'node' | 'child',
  id: string,
  count: number,
): Promise<void> {
  if (count === 1) return;
  const cancelled =
    kind === 'node'
      ? await db.client.nodeRun.findFirst({
          where: { ...runningNodeRun(scope, id), status: 'cancelled' },
          select: { id: true },
        })
      : await db.client.childExecution.findFirst({
          where: { ...runningChild(scope, id), status: 'cancelled' },
          select: { id: true },
        });
  if (cancelled) throw new WorkflowExecutionCancelled(scope.workflowRunId);
  assertChanged(count);
}
