import {
  nodeRunSchema,
  resumeWorkflowRunRequestSchema,
  startWorkflowRunRequestSchema,
  workflowIdentifierSchema,
  workflowInvocationKeySchema,
  workflowInvocationLookupResponseSchema,
  workflowRunResponseSchema,
  type NodeRun,
  type WorkflowRunResponse,
} from '@dramaflow/contracts';
import { z } from 'zod';
import {
  DatabaseService,
  WorkflowRunSubmissionFactory,
  WorkflowOutboxDispatcher,
  WorkflowHumanReviewService,
} from '@dramaflow/server';
import type {
  ResumeWorkflowRunInput,
  StartWorkflowRunInput,
} from '@dramaflow/workflow';
import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  workflowResourceNotFound,
  workflowRuntimeHttpError,
  type WorkflowResourceNotFoundCode,
} from './workflow-runtime-http-error.js';

const workflowNodeRunsResponseSchema = z
  .object({ items: z.array(nodeRunSchema) })
  .strict();

@Injectable()
export class WorkflowRuntimeService {
  constructor(
    private readonly submissions: WorkflowRunSubmissionFactory,
    private readonly dispatcher: WorkflowOutboxDispatcher,
    private readonly database: DatabaseService,
    private readonly humanReviews: WorkflowHumanReviewService,
  ) {}

  async startVersion(
    ownerId: string,
    body: unknown,
  ): Promise<WorkflowRunResponse> {
    const request = startWorkflowRunRequestSchema.parse(body);
    const version = await this.database.client.workflowVersion.findFirst({
      where: {
        id: request.workflowVersionId,
        workflow: { project: { ownerId } },
      },
      select: { workflow: { select: { id: true, projectId: true } } },
    });
    if (!version) throw workflowResourceNotFound('WORKFLOW_VERSION_NOT_FOUND');
    const run = await this.httpOperation(
      'WORKFLOW_VERSION_NOT_FOUND',
      async () => {
        const pending = await this.submitStart(ownerId, {
          projectId: version.workflow.projectId,
          workflowId: version.workflow.id,
          workflowVersionId: request.workflowVersionId,
          invocationKey: request.invocationKey,
          inputs: request.inputs,
        });
        // 成功响应前确认 Redis 入队；故障时 PostgreSQL Outbox 仍可由 Worker 重投。
        if (pending.status === 'pending') {
          try {
            await this.dispatcher.publishStart(pending.id);
          } catch {
            throw new ServiceUnavailableException({
              code: 'WORKFLOW_QUEUE_UNAVAILABLE',
              message: '执行命令已持久保存，入队结果尚未确认',
              workflowRunId: pending.id,
              invocationKey: pending.invocationKey,
            });
          }
        }
        return pending;
      },
    );
    const { projectId: _projectId, threadId: _threadId, ...response } = run;
    return workflowRunResponseSchema.parse(response);
  }

  async getRun(ownerId: string, rawId: string): Promise<WorkflowRunResponse> {
    const runId = workflowIdentifierSchema.parse(rawId);
    return this.httpOperation('WORKFLOW_RUN_NOT_FOUND', async () => {
      const run = await this.authorizedRun(ownerId, runId);
      return workflowRunResponseSchema.parse({
        id: run.id,
        workflowId: run.workflowId,
        workflowVersionId: run.workflowVersionId,
        invocationKey: run.invocationKey,
        status: run.status,
        inputs: run.inputs,
        createdAt: run.createdAt.toISOString(),
        ...(run.outputs !== null ? { outputs: run.outputs } : {}),
        ...(run.error !== null ? { error: run.error } : {}),
        ...(run.startedAt !== null
          ? { startedAt: run.startedAt.toISOString() }
          : {}),
        ...(run.completedAt !== null
          ? { completedAt: run.completedAt.toISOString() }
          : {}),
      });
    });
  }

  async lookupInvocation(
    ownerId: string,
    rawWorkflowId: string,
    rawKey: string,
  ) {
    const workflowId = workflowIdentifierSchema.parse(rawWorkflowId);
    const invocationKey = workflowInvocationKeySchema.parse(rawKey);
    const workflow = await this.database.client.workflow.findFirst({
      where: { id: workflowId, project: { ownerId } },
      select: { projectId: true },
    });
    if (!workflow) throw new NotFoundException('工作流不存在或无权访问');
    const run = await this.database.client.workflowRun.findFirst({
      where: {
        workflowId,
        invocationKey,
        projectId: workflow.projectId,
        project: { ownerId },
      },
      select: { id: true },
    });
    // 复用既有授权查询及安全投影；lookup 不进入 Submission / Dispatcher。
    return workflowInvocationLookupResponseSchema.parse({
      run: run ? await this.getRun(ownerId, run.id) : null,
    });
  }

  async resumeRun(
    ownerId: string,
    rawId: string,
    body: unknown,
  ): Promise<WorkflowRunResponse> {
    const runId = workflowIdentifierSchema.parse(rawId);
    const request = resumeWorkflowRunRequestSchema.parse(body);
    await this.httpOperation('WORKFLOW_RUN_NOT_FOUND', async () => {
      const job = await this.humanReviews.submit(ownerId, runId, request);
      await this.dispatcher.publishExecution(job.executionId);
    });
    return this.getRun(ownerId, runId);
  }

  async pendingHumanReviews(ownerId: string, rawId: string) {
    const runId = workflowIdentifierSchema.parse(rawId);
    return this.httpOperation('WORKFLOW_RUN_NOT_FOUND', () =>
      this.humanReviews.pending(ownerId, runId),
    );
  }

  async listNodeRuns(
    ownerId: string,
    rawId: string,
  ): Promise<{ items: NodeRun[] }> {
    const runId = workflowIdentifierSchema.parse(rawId);
    return this.httpOperation('WORKFLOW_RUN_NOT_FOUND', async () => {
      const run = await this.authorizedRun(ownerId, runId);
      const rows = await this.database.client.nodeRun.findMany({
        where: {
          workflowRunId: run.id,
          projectId: run.projectId,
          project: { ownerId },
        },
        orderBy: [{ startedAt: 'asc' }, { attempt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          workflowRunId: true,
          nodeId: true,
          occurrenceId: true,
          occurrence: { select: { scopeKey: true } },
          attempt: true,
          status: true,
          inputs: true,
          outputs: true,
          error: true,
          startedAt: true,
          completedAt: true,
        },
      });
      return workflowNodeRunsResponseSchema.parse({
        items: rows.map((row) => ({
          id: row.id,
          workflowRunId: row.workflowRunId,
          nodeId: row.nodeId,
          occurrenceId: row.occurrenceId,
          scopeKey: row.occurrence.scopeKey,
          attempt: row.attempt,
          status: row.status,
          ...(row.inputs !== null ? { inputs: row.inputs } : {}),
          ...(row.outputs !== null ? { outputs: row.outputs } : {}),
          ...(row.error !== null ? { error: row.error } : {}),
          startedAt: row.startedAt.toISOString(),
          ...(row.completedAt !== null
            ? { completedAt: row.completedAt.toISOString() }
            : {}),
        })),
      });
    });
  }

  private async authorizedRun(ownerId: string, runId: string) {
    const run = await this.database.client.workflowRun.findFirst({
      where: { id: runId, project: { ownerId } },
      select: {
        id: true,
        projectId: true,
        workflowId: true,
        workflowVersionId: true,
        invocationKey: true,
        status: true,
        inputs: true,
        outputs: true,
        error: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
    });
    if (!run) throw workflowResourceNotFound('WORKFLOW_RUN_NOT_FOUND');
    return run;
  }

  private async httpOperation<T>(
    code: WorkflowResourceNotFoundCode,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw workflowRuntimeHttpError(error, code);
    }
  }

  async submitStart(ownerId: string, input: StartWorkflowRunInput) {
    const submission = await this.submissions.forProject(
      ownerId,
      input.projectId,
    );
    return submission.start(input);
  }

  async submitResume(
    ownerId: string,
    projectId: string,
    input: ResumeWorkflowRunInput,
  ) {
    const submission = await this.submissions.forProject(ownerId, projectId);
    return submission.resume(input);
  }
}
