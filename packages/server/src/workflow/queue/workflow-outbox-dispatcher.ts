import { workflowExecutionJobSchema } from '@dramaflow/contracts';
import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { WorkflowExecutionQueue } from './workflow-execution-queue.js';
import { WorkflowCancellationReconciler } from './workflow-cancellation-reconciler.js';

@Injectable()
export class WorkflowOutboxDispatcher {
  constructor(
    private readonly db: DatabaseService,
    private readonly queue: WorkflowExecutionQueue,
  ) {}

  async publishStart(workflowRunId: string): Promise<void> {
    const row = await this.db.client.workflowExecutionOutbox.findUniqueOrThrow({
      where: {
        workflowRunId_kind_waitingRevision: { workflowRunId, kind: 'start', waitingRevision: 0 },
      },
    });
    await this.publishExecution(row.id);
  }

  async publishExecution(executionId: string): Promise<void> {
    const outcome = await this.dispatch(executionId);
    if (outcome === 'failed')
      throw new ServiceUnavailableException({
        code: 'WORKFLOW_QUEUE_UNAVAILABLE',
        message: '执行命令已持久保存，队列暂不可用',
      });
  }

  async dispatchNext(): Promise<boolean> {
    return (await this.dispatch()) !== 'idle';
  }

  private async dispatch(
    executionId?: string,
  ): Promise<'published' | 'cancelled' | 'failed' | 'idle'> {
    // 行锁随事务结束自动释放；enqueue 已完成但 DB 未提交时，后续以确定性 Job ID 重投。
    return this.db.client.$transaction(
      async (tx) => {
        const rows = executionId
          ? await tx.$queryRaw<
              { id: string }[]
            >`SELECT "id" FROM "workflow_execution_outbox" WHERE "id" = ${executionId} FOR UPDATE`
          : await tx.$queryRaw<
              { id: string }[]
            >`SELECT "id" FROM "workflow_execution_outbox" WHERE "status" = 'pending' AND "availableAt" <= NOW() ORDER BY "createdAt", "id" LIMIT 1 FOR UPDATE SKIP LOCKED`;
        const id = rows[0]?.id;
        if (!id) {
          if (executionId) throw new NotFoundException('执行意图不存在');
          return 'idle';
        }
        const row = await tx.workflowExecutionOutbox.findUniqueOrThrow({
          where: { id },
          include: { workflowRun: { select: { cancellationRequestedAt: true, status: true } } },
        });
        if (row.status !== 'pending') return row.status === 'cancelled' ? 'cancelled' : 'published';
        if (
          row.workflowRun.cancellationRequestedAt !== null ||
          row.workflowRun.status === 'cancelled'
        ) {
          await tx.workflowExecutionOutbox.update({
            where: { id },
            data: { status: 'cancelled', completedAt: new Date() },
          });
          return 'cancelled'; // 正常结算，不作为队列故障重试；不需要删除 Redis Job。
        }
        const job = workflowExecutionJobSchema.parse(row.payload);
        try {
          await this.queue.publish(job);
        } catch {
          // 仅持久化投递次数与退避，不保存可能含凭证的驱动错误；不改变 Run 生命周期。
          await tx.workflowExecutionOutbox.update({
            where: { id },
            data: {
              attempts: { increment: 1 },
              availableAt: new Date(
                Date.now() + Math.min(30000, 1000 * 2 ** Math.min(row.attempts, 5)),
              ),
            },
          });
          return 'failed';
        }
        await tx.workflowExecutionOutbox.update({
          where: { id },
          data: { status: 'published', publishedAt: new Date(), attempts: { increment: 1 } },
        });
        return 'published';
      },
      { timeout: 15000 },
    );
  }
}

// 仅由 Worker 注册；API 只显式确认当前请求入队，不运行背景扫描或 Graph。
@Injectable()
export class WorkflowOutboxPump implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private active: Promise<void> = Promise.resolve();
  private readonly interval = z.coerce
    .number()
    .int()
    .min(100)
    .parse(process.env.WORKFLOW_OUTBOX_INTERVAL_MS ?? 1000);
  constructor(
    private readonly dispatcher: WorkflowOutboxDispatcher,
    private readonly cancellations: WorkflowCancellationReconciler,
  ) {}
  onApplicationBootstrap(): void {
    this.schedule(0);
  }
  private schedule(delay: number): void {
    if (!this.stopped)
      this.timer = setTimeout(() => {
        this.active = this.tick();
      }, delay);
  }
  private async tick(): Promise<void> {
    try {
      await this.cancellations.reconcileBatch();
    } catch {
      new Logger('WorkflowOutbox').warn('取消核查暂不可用，保留持久化事实等待下轮核查');
    }
    try {
      for (let i = 0; i < 20 && !this.stopped; i++)
        if (!(await this.dispatcher.dispatchNext())) break;
    } catch {
      new Logger('WorkflowOutbox').warn('执行命令投递暂不可用，保留 Outbox 等待重投');
    } finally {
      this.schedule(this.interval);
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
}
