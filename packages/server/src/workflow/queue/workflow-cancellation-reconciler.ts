import { Injectable } from '@nestjs/common';
import { Prisma } from '@dramaflow/database';
import { workflowExecutionJobSchema } from '@dramaflow/contracts';
import { DatabaseService } from '../../database/database.service.js';
import { WorkflowRunRepositories } from '../run/repository/workflow-run-repository.js';
import { currentExecutionKey } from '../run/cancellation/current-execution.js';
import { WorkflowExecutionQueue } from './workflow-execution-queue.js';

const batchSize = 5;
const unsettled = ['pending', 'published', 'executing', 'recovery_required'];

@Injectable()
export class WorkflowCancellationReconciler {
  // 仅为公平扫描位置；丢失此游标会重扫，不影响持久化 gate / 核查结果。
  private cursor?: { cancellationRequestedAt: Date; id: string };
  constructor(
    private readonly db: DatabaseService,
    private readonly queue: WorkflowExecutionQueue,
    private readonly runs: WorkflowRunRepositories,
  ) {}

  async reconcileBatch(now = new Date()): Promise<void> {
    // 宽限期仅筛候选，不代表执行超时或 Worker 已死亡。
    const rows = await this.db.client.workflowRun.findMany({
      where: {
        cancellationRequestedAt: { not: null, lte: new Date(now.getTime() - 30000) },
        OR: [
          { status: { in: ['pending', 'running', 'waiting'] } },
          { executions: { some: { status: { in: unsettled } } } },
        ],
        ...(this.cursor
          ? {
              AND: [
                {
                  OR: [
                    { cancellationRequestedAt: { gt: this.cursor.cancellationRequestedAt } },
                    {
                      cancellationRequestedAt: this.cursor.cancellationRequestedAt,
                      id: { gt: this.cursor.id },
                    },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ cancellationRequestedAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
      select: { id: true, cancellationRequestedAt: true },
    });
    for (const row of rows) {
      this.cursor = { id: row.id, cancellationRequestedAt: row.cancellationRequestedAt! };
      await this.reconcile(row.id);
    }
    const last = rows.at(-1);
    this.cursor =
      rows.length === batchSize && last
        ? { id: last.id, cancellationRequestedAt: last.cancellationRequestedAt! }
        : undefined;
  }

  async reconcile(runId: string): Promise<void> {
    const read = () =>
      this.db.client.workflowRun.findUnique({
        where: { id: runId },
        include: { project: { select: { ownerId: true } }, executions: true },
      });
    let run = await read();
    if (!run?.cancellationRequestedAt) return;
    if (run.status === 'pending' || run.status === 'waiting') {
      // 复用原子取消事务；若 resume 已先 claim，仅得到 in_flight，不伪造等待收尾。
      const repository = await this.runs.forProject(run.project.ownerId, run.projectId);
      await repository.requestCancellation(run.id);
      run = await read();
      if (!run) return;
    }
    const key = currentExecutionKey(run);
    const current = run.executions.find(
      (intent) => intent.kind === key.kind && intent.waitingRevision === key.waitingRevision,
    );
    // waiting 取消可能没有新 resume 命令；前一次 invocation 达到该 waitingRevision 已是确定事实。
    const intent =
      current ??
      (run.status === 'cancelled' && run.waitingRevision > 0
        ? run.executions.find(
            (candidate) =>
              candidate.kind === (run!.waitingRevision === 1 ? 'start' : 'resume') &&
              candidate.waitingRevision === run!.waitingRevision - 1,
          )
        : undefined);
    if (!intent || !unsettled.includes(intent.status)) return;
    if (run.status === 'running' && intent.status === 'recovery_required') return;
    let active = false;
    if (run.status === 'running' && intent.status === 'executing') {
      const job = workflowExecutionJobSchema.safeParse(intent.payload);
      if (job.success) active = await this.queue.hasActiveExecutionEvidence(job.data);
    }
    await this.db.client.$transaction(
      async (tx) => {
        // 与取消 / claim 同一 Run 行锁。Redis 观察在锁外，写入前重读真正的领域事实。
        await tx.$queryRaw`SELECT "id" FROM "workflow_run" WHERE "id" = ${runId} FOR UPDATE`;
        const latest = await tx.workflowRun.findUniqueOrThrow({ where: { id: runId } });
        if (!latest.cancellationRequestedAt || latest.waitingRevision !== run!.waitingRevision)
          return;
        const terminal = ['completed', 'failed', 'cancelled'].includes(latest.status);
        if (!terminal && (latest.status !== 'running' || active)) return;
        await tx.workflowExecutionOutbox.updateMany({
          where: { id: intent.id, workflowRunId: runId, status: { in: unsettled } },
          data: { status: terminal ? latest.status : 'recovery_required', completedAt: new Date() },
        });
        // 不写 Run / NodeRun / ChildExecution；原 owner 的 late fact 继续按既有 CAS 收尾。
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}
