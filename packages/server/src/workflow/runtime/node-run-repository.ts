import {
  iterationItemRunSchema,
  nodeRunErrorSchema,
  nodeOccurrenceSchema,
  nodeRunSchema,
  runtimeValueMapSchema,
  workflowDefinitionSchema,
  workflowIdentifierSchema,
  type NodeRun,
  type NodeOccurrence,
  type NodeRunError,
  type RuntimeValue,
} from '@dramaflow/contracts';
import { Prisma } from '@dramaflow/database';
import { DatabaseService } from '../../database/database.service.js';
import { deriveChildScope } from '@dramaflow/workflow';
import type {
  CreateNodeRunInput,
  GetNodeOccurrenceInput,
  HumanReviewNodeRunRepository,
  IterationRunRepository,
  CreateIterationItemRunInput,
} from '@dramaflow/workflow';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';

interface RepositoryScope {
  readonly ownerId: string;
  readonly projectId: string;
  readonly workflowRunId: string;
}

function snapshot(values: Record<string, RuntimeValue>): Prisma.InputJsonObject {
  return z.record(z.string(), z.json()).parse(runtimeValueMapSchema.parse(values));
}

// 不提供未限定项目 / 运行的公开 Repository 实例，也不增加 HTTP 运行入口。
class PrismaNodeRunRepository implements HumanReviewNodeRunRepository, IterationRunRepository {
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

  private async lockOccurrence(tx: Prisma.TransactionClient, input: CreateNodeRunInput) {
    const { projectId, workflowRunId, ownerId } = this.scope;
    if (input.workflowRunId !== workflowRunId) throw new Error('节点执行记录与已授权运行不匹配');
    const nodeId = workflowIdentifierSchema.parse(input.nodeId);
    const occurrenceId = z.uuid().parse(input.occurrenceId);
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
    const item = await tx.iterationItemRun.findUnique({
      where: { workflowRunId_scopeKey: { workflowRunId, scopeKey: occurrence.scopeKey } },
    });
    if (input.iterationItemRunId !== item?.id || (item && item.status !== 'running'))
      throw new Error('Body NodeRun 与 item execution 作用域不匹配或 item 已结束');
    return { run, occurrence };
  }

  async createRunning(input: CreateNodeRunInput): Promise<NodeRun> {
    const { projectId, workflowRunId } = this.scope;
    return this.db.client.$transaction(
      async (tx) => {
        const { occurrence } = await this.lockOccurrence(tx, input);
        // 仅在这一 occurrence 内分配；行锁随事务释放，不增加业务重试策略。
        const previous = await tx.nodeRun.aggregate({
          where: { occurrenceId: occurrence.id },
          _max: { attempt: true },
        });
        const row = await tx.nodeRun.create({
          data: {
            projectId,
            workflowRunId,
            nodeId: occurrence.nodeId,
            occurrenceId: occurrence.id,
            iterationItemRunId: input.iterationItemRunId,
            attempt: (previous._max.attempt ?? 0) + 1,
          },
        });
        return nodeRunSchema.parse({
          id: row.id,
          workflowRunId: row.workflowRunId,
          nodeId: row.nodeId,
          occurrenceId: occurrence.id,
          scopeKey: occurrence.scopeKey,
          ...(row.iterationItemRunId ? { iterationItemRunId: row.iterationItemRunId } : {}),
          attempt: row.attempt,
          status: row.status,
          startedAt: row.startedAt.toISOString(),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async getOrCreateHumanReviewRunning(
    input: CreateNodeRunInput & { readonly workflowVersionId: string },
  ): Promise<NodeRun> {
    const { projectId, workflowRunId, ownerId } = this.scope;
    const nodeId = workflowIdentifierSchema.parse(input.nodeId);
    const workflowVersionId = workflowIdentifierSchema.parse(input.workflowVersionId);
    return this.db.client.$transaction(
      async (tx) => {
        // 与 Action attempt 分配锁同一 occurrence；重入不能换成其他 item 的记录。
        const { run, occurrence } = await this.lockOccurrence(tx, input);
        if (run.status !== 'running' || run.workflowVersionId !== workflowVersionId)
          throw new Error('Human Review 必须属于当前已 claim 的固定版本运行');
        const version = await tx.workflowVersion.findFirst({
          where: {
            id: workflowVersionId,
            workflowId: run.workflowId,
            workflow: { projectId, project: { ownerId } },
          },
          select: { definition: true },
        });
        const node =
          version &&
          workflowDefinitionSchema
            .parse(version.definition)
            .nodes.find((node) => node.id === nodeId);
        if (!node || node.type !== 'flow.human_review' || node.typeVersion !== 1)
          throw new Error('固定运行版本中的节点不是 flow.human_review@1');
        // 当前仍由 Compiler gate 串行审核；审计复用只依赖明确 occurrence。
        // 不按 latest running 猜身份；任何终态或多 attempt 的旧记录均拒绝复用。
        const existing = await tx.nodeRun.findMany({
          where: { projectId, workflowRunId, occurrenceId: occurrence.id },
          take: 2,
        });
        const previous = existing[0];
        if (
          previous &&
          (existing.length !== 1 || previous.attempt !== 1 || previous.status !== 'running')
        )
          throw new Error('Human Review 已结束或存在不支持的 attempt 历史');
        const row =
          previous ??
          (await tx.nodeRun.create({
            data: {
              projectId,
              workflowRunId,
              nodeId,
              occurrenceId: occurrence.id,
              iterationItemRunId: input.iterationItemRunId,
              attempt: 1,
            },
          }));
        return nodeRunSchema.parse({
          id: row.id,
          workflowRunId: row.workflowRunId,
          nodeId: row.nodeId,
          occurrenceId: occurrence.id,
          scopeKey: occurrence.scopeKey,
          ...(row.iterationItemRunId ? { iterationItemRunId: row.iterationItemRunId } : {}),
          attempt: row.attempt,
          status: row.status,
          startedAt: row.startedAt.toISOString(),
          ...(row.inputs !== null ? { inputs: row.inputs } : {}),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async getOrCreateIterationItemRunning(raw: CreateIterationItemRunInput) {
    const input = iterationItemRunSchema
      .pick({
        workflowRunId: true,
        iterationNodeRunId: true,
        iterationNodeId: true,
        scopeKey: true,
        index: true,
      })
      .parse(raw);
    const { projectId, workflowRunId } = this.scope;
    if (input.workflowRunId !== workflowRunId) throw new Error('Item 与已授权运行不匹配');
    return this.db.client.$transaction(
      async (tx) => {
        const parent = await tx.nodeRun.findFirst({
          where: { ...this.running(input.iterationNodeRunId), nodeId: input.iterationNodeId },
          include: { occurrence: true },
        });
        if (!parent) throw new NotFoundException('Iteration NodeRun 不存在、已结束或无权访问');
        const expectedScope = deriveChildScope(parent.occurrence.scopeKey, {
          kind: 'iteration_item',
          ownerOccurrenceId: parent.occurrenceId,
          ownerNodeRunId: parent.id,
          slot: 'body',
          index: input.index,
        });
        if (input.scopeKey !== expectedScope) throw new Error('Item scope 与父 NodeRun 不匹配');
        const lockKey = JSON.stringify([workflowRunId, input.iterationNodeRunId, input.index]);
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const existing = await tx.iterationItemRun.findUnique({
          where: {
            iterationNodeRunId_index: {
              iterationNodeRunId: input.iterationNodeRunId,
              index: input.index,
            },
          },
        });
        if (existing && (existing.status !== 'running' || existing.scopeKey !== input.scopeKey))
          throw new Error('Item execution 已结束或身份不匹配');
        const row =
          existing ?? (await tx.iterationItemRun.create({ data: { ...input, projectId } }));
        return iterationItemRunSchema.parse({
          id: row.id,
          ...input,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          startedAt: row.startedAt.toISOString(),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private runningItem(id: string): Prisma.IterationItemRunWhereInput {
    return {
      id: z.uuid().parse(id),
      projectId: this.scope.projectId,
      workflowRunId: this.scope.workflowRunId,
      workflowRun: { project: { ownerId: this.scope.ownerId } },
      status: 'running',
    };
  }

  async markIterationItemCompleted(id: string): Promise<void> {
    const result = await this.db.client.iterationItemRun.updateMany({
      where: this.runningItem(id),
      data: { status: 'completed', completedAt: new Date() },
    });
    this.assertChanged(result.count);
  }

  async markIterationItemFailed(id: string, rawError: NodeRunError): Promise<void> {
    const error = nodeRunErrorSchema.parse(rawError);
    await this.db.client.$transaction(async (tx) => {
      const item = await tx.iterationItemRun.findFirst({
        where: { ...this.runningItem(id), status: { in: ['running', 'failed'] } },
      });
      if (!item) throw new Error('Item execution 不存在、无权访问或已结束');
      const completedAt = new Date();
      // 同一 item 的并行 body 分支可同时失败；只首次更新，保留首个错误。
      await tx.iterationItemRun.updateMany({
        where: this.runningItem(id),
        data: { status: 'failed', error, completedAt },
      });
      await tx.nodeRun.updateMany({
        where: this.running(item.iterationNodeRunId),
        data: { status: 'failed', error, completedAt },
      });
    });
  }

  private running(nodeRunId: string): Prisma.NodeRunWhereInput {
    return {
      id: z.uuid().parse(nodeRunId),
      projectId: this.scope.projectId,
      workflowRunId: this.scope.workflowRunId,
      project: { ownerId: this.scope.ownerId },
      status: 'running',
    };
  }

  private assertChanged(count: number): void {
    if (count !== 1) throw new Error('节点执行记录不存在、无权访问或状态不允许此更新');
  }

  async updateInputs(nodeRunId: string, inputs: Record<string, RuntimeValue>): Promise<void> {
    const changed = await this.db.client.nodeRun.updateMany({
      where: { ...this.running(nodeRunId), inputs: { equals: Prisma.DbNull } },
      data: { inputs: snapshot(inputs) },
    });
    this.assertChanged(changed.count);
  }

  async markCompleted(nodeRunId: string, outputs: Record<string, RuntimeValue>): Promise<void> {
    const changed = await this.db.client.nodeRun.updateMany({
      where: { ...this.running(nodeRunId), inputs: { not: Prisma.DbNull } },
      data: {
        outputs: snapshot(outputs),
        status: 'completed',
        completedAt: new Date(),
      },
    });
    this.assertChanged(changed.count);
  }

  async markFailed(nodeRunId: string, error: NodeRunError): Promise<void> {
    const changed = await this.db.client.nodeRun.updateMany({
      where: this.running(nodeRunId),
      data: {
        error: nodeRunErrorSchema.parse(error),
        status: 'failed',
        completedAt: new Date(),
      },
    });
    this.assertChanged(changed.count);
  }
}

@Injectable()
export class NodeRunRepositories {
  constructor(private readonly db: DatabaseService) {}

  async forRun(
    ownerId: string,
    rawProjectId: string,
    rawWorkflowRunId: string,
  ): Promise<HumanReviewNodeRunRepository & IterationRunRepository> {
    const projectId = z.uuid().parse(rawProjectId);
    const workflowRunId = workflowIdentifierSchema.parse(rawWorkflowRunId);
    const run = await this.db.client.workflowRun.findFirst({
      where: { id: workflowRunId, projectId, project: { ownerId } },
      select: { id: true },
    });
    if (!run) throw new NotFoundException('运行不存在或无权访问');
    return new PrismaNodeRunRepository(this.db, {
      ownerId,
      projectId,
      workflowRunId,
    });
  }
}
