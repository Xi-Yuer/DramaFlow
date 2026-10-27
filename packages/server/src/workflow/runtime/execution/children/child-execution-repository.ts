import { isDeepStrictEqual } from 'node:util';
import {
  childExecutionSchema,
  iterationItemExecutionMetadataSchema,
  nodeRunErrorSchema,
  workflowIdentifierSchema,
  type NodeRunError,
} from '@dramaflow/contracts';
import { Prisma } from '@dramaflow/database';
import {
  deriveChildScope,
  iterationItemInvocationKey,
  type CreateChildExecutionInput,
  type CreateIterationItemRunInput,
} from '@dramaflow/workflow';
import { NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { DatabaseService } from '../../../../database/database.service.js';
import {
  assertChanged,
  runningChild,
  runningNodeRun,
  type RepositoryScope,
} from '../repository-scope.js';

export class ChildExecutionRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly scope: RepositoryScope,
  ) {}

  async getOrCreateIterationItemRunning(raw: CreateIterationItemRunInput) {
    const input = z
      .object({
        workflowRunId: workflowIdentifierSchema,
        parentNodeRunId: z.uuid(),
        parentNodeId: workflowIdentifierSchema,
        scopeKey: workflowIdentifierSchema,
        index: z.number().int().nonnegative().max(2147483647),
      })
      .strict()
      .parse(raw);
    return this.createChild({
      workflowRunId: input.workflowRunId,
      parentNodeRunId: input.parentNodeRunId,
      parentNodeId: input.parentNodeId,
      scopeKey: input.scopeKey,
      kind: 'iteration_item',
      invocationKey: iterationItemInvocationKey(input.index),
      metadata: { index: input.index },
    });
  }

  async getOrCreateChildExecutionRunning(input: CreateChildExecutionInput) {
    return this.createChild(input);
  }

  private childRecord(row: Prisma.ChildExecutionGetPayload<Record<string, never>>) {
    return childExecutionSchema.parse({
      id: row.id,
      workflowRunId: row.workflowRunId,
      parentNodeRunId: row.parentNodeRunId,
      parentNodeId: row.parentNodeId,
      scopeKey: row.scopeKey,
      kind: row.kind,
      invocationKey: row.invocationKey,
      metadata: row.metadata,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt.toISOString(),
      ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
      ...(row.error !== null ? { error: row.error } : {}),
    });
  }

  private async createChild(raw: CreateChildExecutionInput) {
    const input = childExecutionSchema
      .pick({
        workflowRunId: true,
        parentNodeRunId: true,
        parentNodeId: true,
        scopeKey: true,
        kind: true,
        invocationKey: true,
        metadata: true,
      })
      .parse(raw);
    const { projectId, workflowRunId } = this.scope;
    if (input.workflowRunId !== workflowRunId || input.scopeKey === 'root')
      throw new Error('ChildExecution 与已授权运行或 scope 不匹配');
    const index =
      input.kind === 'iteration_item'
        ? iterationItemExecutionMetadataSchema.parse(input.metadata).index
        : null;
    if (index !== null && input.invocationKey !== iterationItemInvocationKey(index))
      throw new Error('Iteration invocation identity 无效');
    return this.db.client.$transaction(
      async (tx) => {
        const parent = await tx.nodeRun.findFirst({
          where: {
            ...runningNodeRun(this.scope, input.parentNodeRunId),
            nodeId: input.parentNodeId,
          },
          include: { occurrence: true },
        });
        if (!parent) throw new NotFoundException('Parent NodeRun 不存在、已结束或无权访问');
        if (
          index !== null &&
          input.scopeKey !==
            deriveChildScope(parent.occurrence.scopeKey, {
              kind: 'iteration_item',
              ownerOccurrenceId: parent.occurrenceId,
              ownerNodeRunId: parent.id,
              slot: 'body',
              index,
            })
        )
          throw new Error('Iteration scope 与父 NodeRun 不匹配');
        if (input.scopeKey === parent.occurrence.scopeKey)
          throw new Error('Child scope 不能等于 parent scope');
        const lockKey = JSON.stringify([workflowRunId, input.parentNodeRunId, input.invocationKey]);
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const existing = await tx.childExecution.findUnique({
          where: {
            parentNodeRunId_invocationKey: {
              parentNodeRunId: input.parentNodeRunId,
              invocationKey: input.invocationKey,
            },
          },
        });
        if (
          existing &&
          (existing.status !== 'running' ||
            existing.scopeKey !== input.scopeKey ||
            existing.kind !== input.kind ||
            existing.parentNodeId !== input.parentNodeId ||
            !isDeepStrictEqual(this.childRecord(existing).metadata, input.metadata))
        )
          throw new Error('ChildExecution 已结束或身份不匹配');
        return this.childRecord(
          existing ?? (await tx.childExecution.create({ data: { ...input, projectId, index } })),
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async getChildExecutionById(id: string) {
    const row = await this.db.client.childExecution.findFirst({
      where: {
        id: z.uuid().parse(id),
        projectId: this.scope.projectId,
        workflowRunId: this.scope.workflowRunId,
        workflowRun: { project: { ownerId: this.scope.ownerId } },
      },
    });
    return row ? this.childRecord(row) : null;
  }

  async markChildExecutionCompleted(id: string) {
    const result = await this.db.client.childExecution.updateMany({
      where: runningChild(this.scope, id),
      data: { status: 'completed', completedAt: new Date() },
    });
    assertChanged(result.count);
  }
  async markIterationItemCompleted(id: string) {
    return this.markChildExecutionCompleted(id);
  }
  async markChildExecutionFailed(id: string, error: NodeRunError) {
    return this.failChild(id, error, false);
  }
  async markIterationItemFailed(id: string, error: NodeRunError) {
    return this.failChild(id, error, true, 'iteration_item');
  }
  async markChildExecutionAndParentFailed(id: string, error: NodeRunError) {
    return this.failChild(id, error, true);
  }
  private async failChild(
    id: string,
    rawError: NodeRunError,
    failParent: boolean,
    expectedKind?: string,
  ) {
    const error = nodeRunErrorSchema.parse(rawError);
    await this.db.client.$transaction(async (tx) => {
      const child = await tx.childExecution.findFirst({
        where: { ...runningChild(this.scope, id), status: { in: ['running', 'failed'] } },
      });
      if (!child) throw new Error('ChildExecution 不存在、无权访问或已结束');
      if (expectedKind && child.kind !== expectedKind)
        throw new Error('Iteration helper 不接受其他 ChildExecution kind');
      const completedAt = new Date();
      await tx.childExecution.updateMany({
        where: runningChild(this.scope, id),
        data: { status: 'failed', error, completedAt },
      });
      if (failParent)
        await tx.nodeRun.updateMany({
          where: runningNodeRun(this.scope, child.parentNodeRunId),
          data: { status: 'failed', error, completedAt },
        });
    });
  }
}
