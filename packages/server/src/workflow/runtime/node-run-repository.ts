import {
  nodeRunErrorSchema,
  nodeRunSchema,
  runtimeValueMapSchema,
  workflowIdentifierSchema,
  type NodeRun,
  type NodeRunError,
  type RuntimeValue,
} from '@dramaflow/contracts';
import { Prisma } from '@dramaflow/database';
import { DatabaseService } from '../../database/database.service.js';
import type { CreateNodeRunInput, NodeRunRepository } from '@dramaflow/workflow';
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
class PrismaNodeRunRepository implements NodeRunRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly scope: RepositoryScope,
  ) {}

  async createRunning(input: CreateNodeRunInput): Promise<NodeRun> {
    const { projectId, workflowRunId, ownerId } = this.scope;
    if (input.workflowRunId !== workflowRunId) throw new Error('节点执行记录与已授权运行不匹配');
    const nodeId = workflowIdentifierSchema.parse(input.nodeId);
    return this.db.client.$transaction(
      async (tx) => {
        const run = await tx.workflowRun.findFirst({
          where: { id: workflowRunId, projectId, project: { ownerId } },
          select: { id: true },
        });
        if (!run) throw new NotFoundException('运行不存在或无权访问');
        // 同一运行 / 节点串行分配；锁随事务释放，不重试业务执行，也不需要独立计数实体。
        const lockKey = JSON.stringify([workflowRunId, nodeId]);
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const previous = await tx.nodeRun.aggregate({
          where: { projectId, workflowRunId, nodeId },
          _max: { attempt: true },
        });
        const row = await tx.nodeRun.create({
          data: {
            projectId,
            workflowRunId,
            nodeId,
            attempt: (previous._max.attempt ?? 0) + 1,
          },
        });
        return nodeRunSchema.parse({
          id: row.id,
          workflowRunId: row.workflowRunId,
          nodeId: row.nodeId,
          attempt: row.attempt,
          status: row.status,
          startedAt: row.startedAt.toISOString(),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
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
  ): Promise<NodeRunRepository> {
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
