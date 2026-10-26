import { randomUUID } from 'node:crypto';
import {
  runtimeValueMapSchema,
  workflowIdentifierSchema,
  workflowRunErrorSchema,
  workflowRunSchema,
  workflowInvocationKeySchema,
  type RuntimeValue,
  type WorkflowRun,
  type WorkflowRunError,
  workflowExecutionJobSchema,
  type ResumeWorkflowExecutionJob,
} from '@dramaflow/contracts';
import { Prisma } from '@dramaflow/database';
import { DatabaseService } from '../../../database/database.service.js';
import {
  WorkflowRunNotWaitingError,
  WorkflowResumeAlreadySubmittedError,
  type CreateWorkflowRunInput,
  type WorkflowRunRepository,
  type WorkflowRunSubmissionRepository,
} from '@dramaflow/workflow';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';

const createInputSchema = z
  .object({
    projectId: z.uuid(),
    workflowId: workflowIdentifierSchema,
    workflowVersionId: workflowIdentifierSchema,
    invocationKey: workflowInvocationKeySchema,
    inputs: runtimeValueMapSchema,
  })
  .strict();

function snapshot(values: Record<string, RuntimeValue>): Prisma.InputJsonObject {
  return z.record(z.string(), z.json()).parse(runtimeValueMapSchema.parse(values));
}

interface RepositoryScope {
  readonly ownerId: string;
  readonly projectId: string;
  readonly executionId?: string;
}

function toWorkflowRun(row: Prisma.WorkflowRunGetPayload<Record<string, never>>): WorkflowRun {
  return workflowRunSchema.parse({
    id: row.id,
    projectId: row.projectId,
    workflowId: row.workflowId,
    workflowVersionId: row.workflowVersionId,
    invocationKey: row.invocationKey,
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

class PrismaWorkflowRunRepository
  implements WorkflowRunRepository, WorkflowRunSubmissionRepository
{
  constructor(
    private readonly db: DatabaseService,
    private readonly scope: RepositoryScope,
  ) {}

  private async createRecord(
    tx: Prisma.TransactionClient,
    parsed: CreateWorkflowRunInput,
  ): Promise<WorkflowRun> {
    if (parsed.projectId !== this.scope.projectId) throw new Error('运行与已授权项目不匹配');
    const project = await tx.project.findFirst({
      where: { id: parsed.projectId, ownerId: this.scope.ownerId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('项目不存在或无权访问');
    return toWorkflowRun(
      await tx.workflowRun.create({
        data: {
          ...parsed,
          id: randomUUID(),
          threadId: randomUUID(),
          inputs: snapshot(parsed.inputs),
        },
      }),
    );
  }

  async create(input: CreateWorkflowRunInput): Promise<WorkflowRun> {
    const parsed = createInputSchema.parse(input);
    return this.db.client.$transaction((tx) => this.createRecord(tx, parsed));
  }

  async createWithExecution(
    input: CreateWorkflowRunInput,
  ): Promise<{ run: WorkflowRun; created: boolean }> {
    const parsed = createInputSchema.parse(input);
    try {
      return await this.db.client.$transaction(async (tx) => {
        const run = await this.createRecord(tx, parsed);
        await tx.workflowExecutionOutbox.create({
          data: {
            kind: 'start',
            workflowRunId: run.id,
            payload: { kind: 'start', workflowRunId: run.id },
          },
        });
        return { run, created: true };
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
        throw error;
      // 唯一冲突结束并回滚本次事务后，再读取已提交的胜者；领域层判断调用是否等价。
      const existing = await this.db.client.workflowRun.findFirst({
        where: {
          workflowId: parsed.workflowId,
          invocationKey: parsed.invocationKey,
          projectId: this.scope.projectId,
          project: { ownerId: this.scope.ownerId },
        },
      });
      if (!existing) throw error; // 其他唯一冲突不能伪装成幂等命中。
      return { run: toWorkflowRun(existing), created: false };
    }
  }

  async createResumeExecution(input: {
    workflowRunId: string;
    value: unknown;
  }): Promise<ResumeWorkflowExecutionJob> {
    const request = z
      .object({ workflowRunId: workflowIdentifierSchema, value: z.json() })
      .strict()
      .parse(input);
    return this.db.client.$transaction(async (tx) => {
      // 与执行 claim 使用同一 Run 行锁序列；waiting 状态保持不变。
      await tx.$queryRaw`SELECT "id" FROM "workflow_run" WHERE "id" = ${request.workflowRunId} FOR UPDATE`;
      const run = await tx.workflowRun.findFirst({ where: this.scoped(request.workflowRunId) });
      if (!run || run.status !== 'waiting')
        throw new WorkflowRunNotWaitingError(request.workflowRunId);
      const existing = await tx.workflowExecutionOutbox.findUnique({
        where: {
          workflowRunId_kind_waitingRevision: {
            workflowRunId: run.id,
            kind: 'resume',
            waitingRevision: run.waitingRevision,
          },
        },
      });
      if (existing) throw new WorkflowResumeAlreadySubmittedError();
      const executionId = randomUUID();
      const job: ResumeWorkflowExecutionJob = {
        kind: 'resume',
        executionId,
        workflowRunId: run.id,
        value: request.value,
      };
      await tx.workflowExecutionOutbox.create({
        data: {
          id: executionId,
          kind: 'resume',
          workflowRunId: run.id,
          waitingRevision: run.waitingRevision,
          payload: z.record(z.string(), z.json()).parse(workflowExecutionJobSchema.parse(job)),
        },
      });
      return job;
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

  private async claimExecution(
    workflowRunId: string,
    kind: 'start' | 'resume',
  ): Promise<WorkflowRun | null> {
    return this.db.client.$transaction(async (tx) => {
      const where = this.scoped(workflowRunId);
      const executionId = this.scope.executionId;
      const intent = executionId
        ? await tx.workflowExecutionOutbox.findFirst({
            where: {
              id: executionId,
              workflowRunId,
              kind,
              status: { in: ['pending', 'published'] },
            },
          })
        : null;
      if (executionId && !intent) return null;
      const changed = await tx.workflowRun.updateMany({
        where: {
          ...where,
          status: kind === 'start' ? 'pending' : 'waiting',
          ...(intent ? { waitingRevision: intent.waitingRevision } : {}),
        },
        data: { status: 'running', ...(kind === 'start' ? { startedAt: new Date() } : {}) },
      });
      if (changed.count === 0) return null;
      if (intent) {
        const claimed = await tx.workflowExecutionOutbox.updateMany({
          where: { id: intent.id, status: { in: ['pending', 'published'] } },
          data: { status: 'executing' },
        });
        if (claimed.count !== 1) throw new Error('执行意图抢占失败'); // 整体回滚 Run claim。
      }
      return toWorkflowRun(await tx.workflowRun.findFirstOrThrow({ where }));
    });
  }

  claimPendingForStart(workflowRunId: string): Promise<WorkflowRun | null> {
    return this.claimExecution(workflowRunId, 'start');
  }
  claimWaitingForResume(workflowRunId: string): Promise<WorkflowRun | null> {
    return this.claimExecution(workflowRunId, 'resume');
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

  async forProject(
    ownerId: string,
    rawProjectId: string,
    executionId?: string,
  ): Promise<WorkflowRunRepository & WorkflowRunSubmissionRepository> {
    const projectId = z.uuid().parse(rawProjectId);
    const project = await this.db.client.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('项目不存在或无权访问');
    return new PrismaWorkflowRunRepository(this.db, {
      ownerId,
      projectId,
      ...(executionId ? { executionId } : {}),
    });
  }
}
