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
  type WorkflowRunCancellationRepository,
  type WorkflowRunCancellationResult,
} from '@dramaflow/workflow';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { cancelWaitingReviews } from '../../human-review/cancel-waiting-reviews.js';

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
    ...(row.cancellationRequestedAt != null
      ? { cancellationRequestedAt: row.cancellationRequestedAt.toISOString() }
      : {}),
    ...(row.completedAt !== null ? { completedAt: row.completedAt.toISOString() } : {}),
  });
}

class PrismaWorkflowRunRepository
  implements
    WorkflowRunRepository,
    WorkflowRunSubmissionRepository,
    WorkflowRunCancellationRepository
{
  constructor(
    private readonly db: DatabaseService,
    private readonly scope: RepositoryScope,
    private readonly submissionTransaction?: Prisma.TransactionClient,
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
    if (parsed.projectId !== this.scope.projectId) throw new Error('运行与已授权项目不匹配');
    const accept = async (tx: Prisma.TransactionClient) => {
      // 先序列化同一逻辑调用，避免唯一冲突使调用方组合事务失效；等价性仍由 Submission 判断。
      const lock = JSON.stringify(['workflow-run-start', parsed.workflowId, parsed.invocationKey]);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
      const existing = await tx.workflowRun.findFirst({
        where: {
          workflowId: parsed.workflowId,
          invocationKey: parsed.invocationKey,
          projectId: this.scope.projectId,
          project: { ownerId: this.scope.ownerId },
        },
      });
      if (existing) return { run: toWorkflowRun(existing), created: false };
      const run = await this.createRecord(tx, parsed);
      await tx.workflowExecutionOutbox.create({
        data: {
          kind: 'start',
          workflowRunId: run.id,
          payload: { kind: 'start', workflowRunId: run.id },
        },
      });
      return { run, created: true };
    };
    return this.submissionTransaction
      ? accept(this.submissionTransaction)
      : this.db.client.$transaction(accept);
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
      if (!run || run.status !== 'waiting' || run.cancellationRequestedAt !== null)
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
          cancellationRequestedAt: null,
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
        where: { ...where, status: { in: ['pending', 'waiting'] }, cancellationRequestedAt: null },
        select: { status: true, startedAt: true },
      });
      if (!row) throw new Error('运行不存在、无权访问或状态不允许此更新');
      const changed = await tx.workflowRun.updateMany({
        where: { ...where, status: row.status, cancellationRequestedAt: null },
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

  private async lockRun(tx: Prisma.TransactionClient, workflowRunId: string) {
    const id = workflowIdentifierSchema.parse(workflowRunId);
    await tx.$queryRaw`SELECT r."id" FROM "workflow_run" r JOIN "canvas_project" p ON p."id" = r."projectId" WHERE r."id" = ${id} AND r."projectId" = ${this.scope.projectId}::uuid AND p."ownerId" = ${this.scope.ownerId} FOR UPDATE OF r`;
    const row = await tx.workflowRun.findFirst({ where: this.scoped(id) });
    if (!row) throw new NotFoundException('运行不存在或无权访问');
    return row;
  }

  async requestCancellation(workflowRunId: string): Promise<WorkflowRunCancellationResult> {
    return this.db.client.$transaction(async (tx) => {
      // claim 的条件 UPDATE 与此 Run 行锁互斥；不能依赖队列删除或锁外读取。
      const row = await this.lockRun(tx, workflowRunId);
      if (['completed', 'failed', 'cancelled'].includes(row.status))
        return {
          outcome: row.status === 'cancelled' ? 'cancelled' : 'terminal',
          run: toWorkflowRun(row),
        };
      const requestedAt = row.cancellationRequestedAt ?? new Date();
      const inFlight = row.status === 'running';
      const completedAt = new Date();
      if (row.status === 'waiting') await cancelWaitingReviews(tx, row, completedAt);
      if (row.cancellationRequestedAt === null || !inFlight) {
        const changed = await tx.workflowRun.updateMany({
          where: {
            ...this.scoped(row.id),
            status: row.status,
            cancellationRequestedAt: row.cancellationRequestedAt,
          },
          data: {
            cancellationRequestedAt: requestedAt,
            ...(!inFlight ? { status: 'cancelled', completedAt } : {}),
          },
        });
        this.assertChanged(changed.count);
      }
      // 只结束尚未 claim 的命令；executing / recovery_required 不伪装成已停止。
      await tx.workflowExecutionOutbox.updateMany({
        where: { workflowRunId: row.id, status: { in: ['pending', 'published'] } },
        data: { status: 'cancelled', completedAt: new Date() },
      });
      return {
        outcome: inFlight ? 'in_flight' : 'cancelled',
        run: toWorkflowRun(await tx.workflowRun.findFirstOrThrow({ where: this.scoped(row.id) })),
      };
    });
  }

  // 内部终结操作：调用方须已确认 invocation 结束；请求入口不能用它终结 running。
  async markCancelled(workflowRunId: string): Promise<void> {
    await this.db.client.$transaction(async (tx) => {
      const row = await this.lockRun(tx, workflowRunId);
      const completedAt = new Date();
      if (row.status === 'running' || row.status === 'waiting')
        await cancelWaitingReviews(tx, row, completedAt);
      const changed = await tx.workflowRun.updateMany({
        where: { ...this.scoped(row.id), status: { in: ['running', 'waiting'] } },
        data: {
          status: 'cancelled',
          cancellationRequestedAt: row.cancellationRequestedAt ?? new Date(),
          completedAt,
        },
      });
      this.assertChanged(changed.count);
    });
  }
}

// 内部调用方先明确所有者与项目；HTTP 的资源检查不能替代此处逐次操作的权限检查。
@Injectable()
export class WorkflowRunRepositories {
  constructor(private readonly db: DatabaseService) {}

  async inStartTransaction<T>(
    ownerId: string,
    rawProjectId: string,
    operation: (tx: Prisma.TransactionClient, runs: WorkflowRunSubmissionRepository) => Promise<T>,
  ): Promise<T> {
    const projectId = z.uuid().parse(rawProjectId);
    return this.db.client.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, ownerId },
        select: { id: true },
      });
      if (!project) throw new NotFoundException('项目不存在或无权访问');
      return operation(tx, new PrismaWorkflowRunRepository(this.db, { ownerId, projectId }, tx));
    });
  }

  async forProject(
    ownerId: string,
    rawProjectId: string,
    executionId?: string,
  ): Promise<
    WorkflowRunRepository & WorkflowRunSubmissionRepository & WorkflowRunCancellationRepository
  > {
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
