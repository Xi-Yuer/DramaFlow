import { workflowExecutionJobSchema } from '@dramaflow/contracts';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z, ZodError } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import {
  WorkflowExecutionService,
  WorkflowExecutionTerminalError,
} from '../workflow-execution.service.js';
import { createWorkflowExecutionWorker } from './workflow-execution-queue.js';

export function isRetryableWorkflowInfrastructureError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    [
      'P1001',
      'P1002',
      'P1008',
      'P1017',
      'P2024',
      'P2028',
      'P2034',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      '57P01',
      '40001',
      '40P01',
    ].includes(error.code)
  );
}

@Injectable()
export class WorkflowExecutionConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly worker;
  private running?: Promise<void>;
  private readonly recording = new Set<Promise<void>>();
  constructor(
    private readonly execution: WorkflowExecutionService,
    private readonly db: DatabaseService,
  ) {
    this.worker = createWorkflowExecutionWorker(async (queued) => {
      try {
        const job = workflowExecutionJobSchema.parse(queued.data);
        await this.execution.execute(job);
      } catch (error) {
        if (error instanceof WorkflowExecutionTerminalError)
          throw new UnrecoverableError(error.code);
        if (isRetryableWorkflowInfrastructureError(error))
          throw new Error('WORKFLOW_EXECUTION_INFRASTRUCTURE_UNAVAILABLE');
        throw new UnrecoverableError(
          error instanceof ZodError
            ? 'WORKFLOW_EXECUTION_JOB_INVALID'
            : 'WORKFLOW_EXECUTION_UNEXPECTED_FAILURE',
        );
      }
    });
    this.worker.on('failed', (job, error) => {
      if (!job) return;
      // 重试耗尽 / stalled 超限只标记命令需要人工核查，不把业务运行伪装成 failed 或重跑。
      if (
        error instanceof UnrecoverableError ||
        job.attemptsMade >= (job.opts.attempts ?? 1) ||
        job.failedReason.includes('stalled')
      ) {
        const parsed = workflowExecutionJobSchema.safeParse(job.data);
        if (parsed.success) {
          const data = parsed.data;
          const payload = z.record(z.string(), z.json()).safeParse(data);
          if (!payload.success) return;
          const recording = this.db.client.workflowExecutionOutbox
            .updateMany({
              where: {
                workflowRunId: data.workflowRunId,
                kind: data.kind,
                ...(data.kind === 'resume' ? { id: data.executionId } : {}),
                status: { in: ['pending', 'published', 'executing'] },
                payload: { equals: payload.data },
              },
              data: { status: 'recovery_required', completedAt: new Date() },
            })
            .then(() => undefined)
            .catch(() =>
              new Logger('WorkflowConsumer').error('队列终态记录不可用，需要核查执行意图'),
            );
          this.recording.add(recording);
          void recording.finally(() => this.recording.delete(recording));
        }
      }
    });
  }
  onApplicationBootstrap(): void {
    this.running = this.worker
      .run()
      .catch(() =>
        new Logger('WorkflowConsumer').error('Workflow Consumer 已停止，需要重启 Worker'),
      );
  }
  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
    await this.running;
    await Promise.all(this.recording);
  }
}
