import { randomUUID } from 'node:crypto';
import {
  runtimeValueMapSchema,
  workflowIdentifierSchema,
  workflowRunErrorSchema,
  workflowRunSchema,
  type RuntimeValue,
  type WorkflowRun,
  type WorkflowRunError,
} from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';
import { DatabaseService } from '../database/database.service.js';
import type { CreateWorkflowRunInput, WorkflowRunRepository } from '@dramaflow/workflow';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';

const createInputSchema = z
  .object({
    projectId: z.uuid(),
    workflowId: workflowIdentifierSchema,
    workflowVersionId: workflowIdentifierSchema,
    inputs: runtimeValueMapSchema,
  })
  .strict();

function snapshot(values: Record<string, RuntimeValue>): Prisma.InputJsonObject {
  return z.record(z.string(), z.json()).parse(runtimeValueMapSchema.parse(values));
}

interface RepositoryScope {
  readonly ownerId: string;
  readonly projectId: string;
}

function toWorkflowRun(row: Prisma.WorkflowRunGetPayload<Record<string, never>>): WorkflowRun {
  return workflowRunSchema.parse({
    id: row.id,
    projectId: row.projectId,
    workflowId: row.workflowId,
    workflowVersionId: row.workflowVersionId,
    threadId: row.threadId,
    status: row.status,
    inputs: row.inputs,
    createdAt: row.createdAt.toISOString(),
    ...(row.outputs !== null ? { outputs: row.outputs } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.startedAt !== null ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.completedAt !== null ? { completedAt: row.completedAt.toISOString() } : {}),
  });
}

class PrismaWorkflowRunRepository implements WorkflowRunRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly scope: RepositoryScope,
  ) {}

  async create(input: CreateWorkflowRunInput): Promise<WorkflowRun> {
    const parsed = createInputSchema.parse(input);
    if (parsed.projectId !== this.scope.projectId) throw new Error('运行与已授权项目不匹配');
    return this.db.client.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: parsed.projectId, ownerId: this.scope.ownerId },
        select: { id: true },
      });
      if (!project) throw new NotFoundException('项目不存在或无权访问');
      const row = await tx.workflowRun.create({
        data: {
          ...parsed,
          id: randomUUID(),
          threadId: randomUUID(),
          inputs: snapshot(parsed.inputs),
        },
      });
      return toWorkflowRun(row);
    });
  }

  private scoped(workflowRunId: string): Prisma.WorkflowRunWhereInput {
    return {
      id: workflowIdentifierSchema.parse(workflowRunId),
      projectId: this.scope.projectId,
      project: { ownerId: this.scope.ownerId },
    };
  }

  private assertChanged(count: number): void {
    if (count !== 1) throw new Error('运行不存在、无权访问或状态不允许此更新');
  }

  async getById(workflowRunId: string): Promise<WorkflowRun | null> {
    const row = await this.db.client.workflowRun.findFirst({
      where: this.scoped(workflowRunId),
    });
    return row ? toWorkflowRun(row) : null;
  }

  async claimPendingForStart(workflowRunId: string): Promise<WorkflowRun | null> {
    return this.db.client.$transaction(async (tx) => {
      const where = this.scoped(workflowRunId);
      const changed = await tx.workflowRun.updateMany({
        where: { ...where, status: 'pending' },
        data: { status: 'running', startedAt: new Date() },
      });
      if (changed.count === 0) return null;
      return toWorkflowRun(await tx.workflowRun.findFirstOrThrow({ where }));
    });
  }

  async claimWaitingForResume(workflowRunId: string): Promise<WorkflowRun | null> {
    return this.db.client.$transaction(async (tx) => {
      const where = this.scoped(workflowRunId);
      const changed = await tx.workflowRun.updateMany({
        where: { ...where, status: 'waiting' },
        data: { status: 'running' },
      });
      if (changed.count === 0) return null;
      // 更新锁一直保留到读取 / 校验后的提交，不在应用层先读再决定是否抢占。
      const row = await tx.workflowRun.findFirstOrThrow({ where });
      return toWorkflowRun(row);
    });
  }

  async markRunning(workflowRunId: string): Promise<void> {
    // 首次开始写 startedAt，waiting 恢复保留该时间。更新仍检查读取到的状态，避免并发覆盖。
    await this.db.client.$transaction(async (tx) => {
      const where = this.scoped(workflowRunId);
      const row = await tx.workflowRun.findFirst({
        where: { ...where, status: { in: ['pending', 'waiting'] } },
        select: { status: true, startedAt: true },
      });
      if (!row) throw new Error('运行不存在、无权访问或状态不允许此更新');
      const changed = await tx.workflowRun.updateMany({
        where: { ...where, status: row.status },
        data: { status: 'running', startedAt: row.startedAt ?? new Date() },
      });
      this.assertChanged(changed.count);
    });
  }

  private async transition(
    workflowRunId: string,
    from: string[],
    data: Prisma.WorkflowRunUpdateManyMutationInput,
  ): Promise<void> {
    const changed = await this.db.client.workflowRun.updateMany({
      where: { ...this.scoped(workflowRunId), status: { in: from } },
      data,
    });
    this.assertChanged(changed.count);
  }

  markWaiting(workflowRunId: string): Promise<void> {
    return this.transition(workflowRunId, ['running'], { status: 'waiting' });
  }

  markCompleted(workflowRunId: string, outputs: Record<string, RuntimeValue>): Promise<void> {
    return this.transition(workflowRunId, ['running'], {
      status: 'completed',
      outputs: snapshot(outputs),
      completedAt: new Date(),
    });
  }

  markFailed(workflowRunId: string, error: WorkflowRunError): Promise<void> {
    return this.transition(workflowRunId, ['running'], {
      status: 'failed',
      error: workflowRunErrorSchema.parse(error),
      completedAt: new Date(),
    });
  }

  markCancelled(workflowRunId: string): Promise<void> {
    return this.transition(workflowRunId, ['running', 'waiting'], {
      status: 'cancelled',
      completedAt: new Date(),
    });
  }
}

// 内部调用方先明确所有者与项目；HTTP 的资源检查不能替代此处逐次操作的权限检查。
@Injectable()
export class WorkflowRunRepositories {
  constructor(private readonly db: DatabaseService) {}

  async forProject(ownerId: string, rawProjectId: string): Promise<WorkflowRunRepository> {
    const projectId = z.uuid().parse(rawProjectId);
    const project = await this.db.client.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('项目不存在或无权访问');
    return new PrismaWorkflowRunRepository(this.db, { ownerId, projectId });
  }
}
