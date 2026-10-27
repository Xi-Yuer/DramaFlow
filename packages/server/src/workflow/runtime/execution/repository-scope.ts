import type { Prisma } from '@dramaflow/database';
import { z } from 'zod';

export interface RepositoryScope {
  readonly ownerId: string;
  readonly projectId: string;
  readonly workflowRunId: string;
}

export function runningChild(scope: RepositoryScope, id: string): Prisma.ChildExecutionWhereInput {
  return {
    id: z.uuid().parse(id),
    projectId: scope.projectId,
    workflowRunId: scope.workflowRunId,
    workflowRun: { project: { ownerId: scope.ownerId } },
    status: 'running',
  };
}

export function runningNodeRun(
  scope: RepositoryScope,
  nodeRunId: string,
): Prisma.NodeRunWhereInput {
  return {
    id: z.uuid().parse(nodeRunId),
    projectId: scope.projectId,
    workflowRunId: scope.workflowRunId,
    project: { ownerId: scope.ownerId },
    status: 'running',
  };
}

export function assertChanged(count: number): void {
  if (count !== 1) throw new Error('节点执行记录不存在、无权访问或状态不允许此更新');
}
