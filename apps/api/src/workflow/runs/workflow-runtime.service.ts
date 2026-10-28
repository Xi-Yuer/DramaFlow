import {
  resumeWorkflowRunRequestSchema,
  startWorkflowRunRequestSchema,
  workflowIdentifierSchema,
  workflowInvocationLookupResponseSchema,
  workflowRunResponseSchema,
  type NodeRun,
  type WorkflowRunResponse,
} from '@dramaflow/contracts';
import {
  WorkflowRunSubmissionFactory,
  WorkflowOutboxDispatcher,
  WorkflowHumanReviewService,
  WorkflowRunQueryService,
  WorkflowVersionRepositories,
} from '@dramaflow/server';
import type { ResumeWorkflowRunInput, StartWorkflowRunInput } from '@dramaflow/workflow';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  workflowResourceNotFound,
  workflowRuntimeHttpError,
  type WorkflowResourceNotFoundCode,
} from './workflow-runtime-http-error.js';

@Injectable()
export class WorkflowRuntimeService {
  constructor(
    private readonly submissions: WorkflowRunSubmissionFactory,
    private readonly dispatcher: WorkflowOutboxDispatcher,
    private readonly humanReviews: WorkflowHumanReviewService,
    private readonly runs: WorkflowRunQueryService,
    private readonly versions: WorkflowVersionRepositories,
  ) {}

  async startVersion(ownerId: string, body: unknown): Promise<WorkflowRunResponse> {
    const request = startWorkflowRunRequestSchema.parse(body);
    const version = await this.versions.findOwnedWorkflow(ownerId, request.workflowVersionId);
    if (!version) throw workflowResourceNotFound('WORKFLOW_VERSION_NOT_FOUND');
    const run = await this.httpOperation('WORKFLOW_VERSION_NOT_FOUND', async () => {
      const pending = await this.submitStart(ownerId, {
        projectId: version.projectId,
        workflowId: version.workflowId,
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
    });
    const { projectId: _projectId, threadId: _threadId, ...response } = run;
    return workflowRunResponseSchema.parse(response);
  }

  listRuns(ownerId: string, projectId: string, workflowId: string, query: unknown) {
    return this.runs.listRuns(ownerId, projectId, workflowId, query);
  }

  async getRun(ownerId: string, rawId: string): Promise<WorkflowRunResponse> {
    const runId = workflowIdentifierSchema.parse(rawId);
    return this.httpOperation('WORKFLOW_RUN_NOT_FOUND', () => this.runs.getRun(ownerId, runId));
  }

  async lookupInvocation(ownerId: string, rawWorkflowId: string, rawKey: string) {
    const runId = await this.runs.findInvocationRunId(ownerId, rawWorkflowId, rawKey);
    // 复用既有授权查询及安全投影；lookup 不进入 Submission / Dispatcher。
    return workflowInvocationLookupResponseSchema.parse({
      run: runId ? await this.getRun(ownerId, runId) : null,
    });
  }

  async resumeRun(ownerId: string, rawId: string, body: unknown): Promise<WorkflowRunResponse> {
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

  async listNodeRuns(ownerId: string, rawId: string): Promise<{ items: NodeRun[] }> {
    const runId = workflowIdentifierSchema.parse(rawId);
    return this.httpOperation('WORKFLOW_RUN_NOT_FOUND', () =>
      this.runs.listNodeRuns(ownerId, runId),
    );
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
    const submission = await this.submissions.forProject(ownerId, input.projectId);
    return submission.start(input);
  }

  async submitResume(ownerId: string, projectId: string, input: ResumeWorkflowRunInput) {
    const submission = await this.submissions.forProject(ownerId, projectId);
    return submission.resume(input);
  }
}
