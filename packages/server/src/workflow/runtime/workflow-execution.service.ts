import { isDeepStrictEqual } from 'node:util';
import {
  workflowExecutionJobSchema,
  type WorkflowExecutionJob,
  type ResumeWorkflowExecutionJob,
} from '@dramaflow/contracts';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { WorkflowRuntimeFactory } from './workflow-runtime.factory.js';

export class WorkflowExecutionTerminalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WorkflowExecutionTerminalError';
  }
}

// 仅供 Worker 消费受信任且已落 Outbox 的执行命令；不作为 HTTP 权限入口。
@Injectable()
export class WorkflowExecutionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly runtimes: WorkflowRuntimeFactory,
  ) {}

  executeStart(workflowRunId: string) {
    return this.execute({ kind: 'start', workflowRunId });
  }
  executeResume(input: ResumeWorkflowExecutionJob) {
    return this.execute(input);
  }

  async execute(input: WorkflowExecutionJob) {
    const job = workflowExecutionJobSchema.parse(input);
    const intent = await this.database.client.workflowExecutionOutbox.findFirst({
      where: {
        workflowRunId: job.workflowRunId,
        kind: job.kind,
        ...(job.kind === 'resume' ? { id: job.executionId } : {}),
      },
      include: { workflowRun: { include: { project: { select: { ownerId: true } } } } },
    });
    if (!intent || !isDeepStrictEqual(workflowExecutionJobSchema.parse(intent.payload), job))
      throw new WorkflowExecutionTerminalError('WORKFLOW_EXECUTION_INTENT_INVALID');
    if (intent.status === 'completed')
      return { workflowRunId: job.workflowRunId, status: 'already_processed' as const };
    if (intent.status === 'failed' || intent.status === 'recovery_required')
      throw new WorkflowExecutionTerminalError(
        intent.status === 'failed'
          ? 'WORKFLOW_EXECUTION_FAILED'
          : 'WORKFLOW_EXECUTION_RECOVERY_REQUIRED',
      );
    const run = intent.workflowRun;
    if (intent.status === 'executing') {
      // Graph 已返回终态 / 下一等待周期，但进程在确认命令完成前退出：只补记结果，不再 invoke。
      if (
        run.status === 'completed' ||
        (run.status === 'waiting' && run.waitingRevision === intent.waitingRevision + 1)
      ) {
        await this.finish(intent.id, 'completed');
        return { workflowRunId: run.id, status: 'already_processed' as const };
      }
      await this.finish(intent.id, run.status === 'failed' ? 'failed' : 'recovery_required');
      throw new WorkflowExecutionTerminalError(
        run.status === 'failed'
          ? 'WORKFLOW_EXECUTION_FAILED'
          : 'WORKFLOW_EXECUTION_RECOVERY_REQUIRED',
      );
    }
    if (
      run.status !== (job.kind === 'start' ? 'pending' : 'waiting') ||
      run.waitingRevision !== intent.waitingRevision
    ) {
      await this.finish(intent.id, 'failed');
      throw new WorkflowExecutionTerminalError('WORKFLOW_EXECUTION_INTENT_STALE');
    }
    const runner = await this.runtimes.forProject(run.project.ownerId, run.projectId, intent.id);
    try {
      const result =
        job.kind === 'start'
          ? await runner.executeStart(job.workflowRunId)
          : await runner.executeResume({ workflowRunId: job.workflowRunId, value: job.value });
      await this.finish(intent.id, 'completed');
      return result;
    } catch (error) {
      const latest = await this.database.client.workflowExecutionOutbox.findUniqueOrThrow({
        where: { id: intent.id },
        include: { workflowRun: true },
      });
      if (latest.status === 'completed')
        return { workflowRunId: run.id, status: 'already_processed' as const };
      if (latest.workflowRun.status === 'failed') {
        await this.finish(intent.id, 'failed');
        throw new WorkflowExecutionTerminalError('WORKFLOW_EXECUTION_FAILED');
      }
      if (latest.status === 'executing') {
        if (
          latest.workflowRun.status === 'completed' ||
          (latest.workflowRun.status === 'waiting' &&
            latest.workflowRun.waitingRevision === latest.waitingRevision + 1)
        ) {
          await this.finish(intent.id, 'completed');
          return { workflowRunId: run.id, status: 'already_processed' as const };
        }
        await this.finish(intent.id, 'recovery_required');
        throw new WorkflowExecutionTerminalError('WORKFLOW_EXECUTION_RECOVERY_REQUIRED');
      }
      throw error; // 未 claim 的基础设施故障由 Consumer 按稳定错误码决定是否重试。
    }
  }

  private async finish(
    id: string,
    status: 'completed' | 'failed' | 'recovery_required',
  ): Promise<void> {
    await this.database.client.workflowExecutionOutbox.updateMany({
      where: { id, status: { in: ['pending', 'published', 'executing', 'recovery_required'] } },
      data: { status, completedAt: new Date() },
    });
  }
}
