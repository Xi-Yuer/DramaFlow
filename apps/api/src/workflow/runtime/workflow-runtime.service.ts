import {
  resumeWorkflowRunRequestSchema,
  startWorkflowRunRequestSchema,
  workflowIdentifierSchema,
  workflowRunResponseSchema,
  type WorkflowRunResponse,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  WorkflowRunSubmissionFactory,
  WorkflowExecutionService,
} from '@dramaflow/server';
import type {
  ResumeWorkflowRunInput,
  StartWorkflowRunInput,
} from '@dramaflow/workflow';
import { Injectable } from '@nestjs/common';
import {
  workflowResourceNotFound,
  workflowRuntimeHttpError,
  type WorkflowResourceNotFoundCode,
} from './workflow-runtime-http-error.js';

@Injectable()
export class WorkflowRuntimeService {
  constructor(
    private readonly submissions: WorkflowRunSubmissionFactory,
    private readonly execution: WorkflowExecutionService,
    private readonly database: DatabaseService,
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
          inputs: request.inputs,
        });
        // 临时同步桥接；后续 Queue 仅替换此执行调用，不改变提交服务或 HTTP 契约。
        await this.execution.execute({
          kind: 'start',
          workflowRunId: pending.id,
        });
        return pending;
      },
    );
    return this.getRun(ownerId, run.id);
  }

  async getRun(ownerId: string, rawId: string): Promise<WorkflowRunResponse> {
    const runId = workflowIdentifierSchema.parse(rawId);
    return this.httpOperation('WORKFLOW_RUN_NOT_FOUND', async () => {
      const run = await this.authorizedRun(ownerId, runId);
      return workflowRunResponseSchema.parse({
        id: run.id,
        workflowId: run.workflowId,
        workflowVersionId: run.workflowVersionId,
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

  async resumeRun(
    ownerId: string,
    rawId: string,
    body: unknown,
  ): Promise<WorkflowRunResponse> {
    const runId = workflowIdentifierSchema.parse(rawId);
    const request = resumeWorkflowRunRequestSchema.parse(body);
    // 在调用 Runner 前完成 HTTP 资源权限检查；Runner 的 Repository 仍独立重新检查。
    const run = await this.authorizedRun(ownerId, runId);
    await this.httpOperation('WORKFLOW_RUN_NOT_FOUND', async () => {
      const job = await this.submitResume(ownerId, run.projectId, {
        workflowRunId: runId,
        value: request.value,
      });
      await this.execution.execute(job);
    });
    return this.getRun(ownerId, runId);
  }

  private async authorizedRun(ownerId: string, runId: string) {
    const run = await this.database.client.workflowRun.findFirst({
      where: { id: runId, project: { ownerId } },
      select: {
        id: true,
        projectId: true,
        workflowId: true,
        workflowVersionId: true,
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
