import { assertCancellationGate } from '../cancellation/cancellation-records.js';
import {
  nodeOccurrenceSchema,
  workflowIdentifierSchema,
  type NodeOccurrence,
} from '@dramaflow/contracts';
import { Prisma } from '@dramaflow/database';
import type { GetNodeOccurrenceInput, CreateNodeRunInput } from '@dramaflow/workflow';
import { NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { DatabaseService } from '../../../../database/database.service.js';
import type { RepositoryScope } from '../repository-scope.js';

export class NodeOccurrenceRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly scope: RepositoryScope,
  ) {}

  async getOrCreateOccurrence(input: GetNodeOccurrenceInput): Promise<NodeOccurrence> {
    const identity = nodeOccurrenceSchema.omit({ id: true }).parse(input);
    const { projectId, workflowRunId, ownerId } = this.scope;
    if (identity.workflowRunId !== workflowRunId) throw new Error('节点执行记录与已授权运行不匹配');
    return this.db.client.$transaction(
      async (tx) => {
        await assertCancellationGate(tx, this.scope);
        const run = await tx.workflowRun.findFirst({
          where: { id: workflowRunId, projectId, project: { ownerId } },
          select: { id: true },
        });
        if (!run) throw new NotFoundException('运行不存在或无权访问');
        // 唯一键竞争也串行化；不依赖 find-then-create 或无锁 upsert 的实现细节。
        const lockKey = JSON.stringify([workflowRunId, identity.scopeKey, identity.nodeId]);
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const row =
          (await tx.nodeOccurrence.findUnique({
            where: { workflowRunId_scopeKey_nodeId: identity },
          })) ?? (await tx.nodeOccurrence.create({ data: { ...identity, projectId } }));
        return nodeOccurrenceSchema.parse({
          id: row.id,
          workflowRunId,
          nodeId: row.nodeId,
          scopeKey: row.scopeKey,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async lockOccurrence(tx: Prisma.TransactionClient, input: CreateNodeRunInput) {
    const { projectId, workflowRunId, ownerId } = this.scope;
    if (input.workflowRunId !== workflowRunId) throw new Error('节点执行记录与已授权运行不匹配');
    const nodeId = workflowIdentifierSchema.parse(input.nodeId);
    const occurrenceId = z.uuid().parse(input.occurrenceId);
    await assertCancellationGate(tx, this.scope);
    const run = await tx.workflowRun.findFirst({
      where: { id: workflowRunId, projectId, project: { ownerId } },
      select: { workflowId: true, workflowVersionId: true, status: true },
    });
    if (!run) throw new NotFoundException('运行不存在或无权访问');
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "node_occurrence"
      WHERE "id" = ${occurrenceId}::uuid AND "projectId" = ${projectId}::uuid
        AND "workflowRunId" = ${workflowRunId} AND "nodeId" = ${nodeId} FOR UPDATE`;
    if (locked.length !== 1)
      throw new NotFoundException('节点 occurrence 不存在或与执行身份不匹配');
    const occurrence = await tx.nodeOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } });
    if (input.childExecutionId) {
      const child = await tx.childExecution.findFirst({
        where: {
          id: z.uuid().parse(input.childExecutionId),
          projectId,
          workflowRunId,
        },
      });
      if (
        !child ||
        child.status !== 'running' ||
        child.scopeKey !== occurrence.scopeKey ||
        occurrence.scopeKey === 'root'
      )
        throw new Error('NodeRun 与 ChildExecution 作用域不匹配或已结束');
    } else if (occurrence.scopeKey !== 'root') {
      throw new Error('非 root NodeRun 必须明确指定 ChildExecution');
    }
    return { run, occurrence };
  }
}
