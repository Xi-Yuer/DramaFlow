import {
  runtimeValueMapSchema,
  workflowIdentifierSchema,
  workflowRunSchema,
  type WorkflowRun,
  type ResumeWorkflowExecutionJob,
} from '@dramaflow/contracts';
import { z } from 'zod';
import type { WorkflowRunSubmissionRepository } from './workflow-run-submission-repository.js';
import {
  loadWorkflowVersion,
  type WorkflowVersionRepository,
} from './workflow-version-repository.js';

const startInputSchema = z
  .object({
    projectId: workflowIdentifierSchema,
    workflowId: workflowIdentifierSchema,
    workflowVersionId: workflowIdentifierSchema,
    inputs: runtimeValueMapSchema,
  })
  .strict();
export type StartWorkflowRunInput = z.infer<typeof startInputSchema>;
export interface ResumeWorkflowRunInput {
  readonly workflowRunId: string;
  readonly value: unknown;
}

export interface WorkflowRunSubmissionService {
  start(input: StartWorkflowRunInput): Promise<WorkflowRun>;
  resume(input: ResumeWorkflowRunInput): Promise<ResumeWorkflowExecutionJob>;
}

// 本层不执行 Graph、不抢占状态；事务记录 Outbox，Dispatcher 负责持久投递。
export class DefaultWorkflowRunSubmissionService implements WorkflowRunSubmissionService {
  constructor(
    private readonly versions: WorkflowVersionRepository,
    private readonly runs: WorkflowRunSubmissionRepository,
  ) {}

  async start(input: StartWorkflowRunInput): Promise<WorkflowRun> {
    const request = startInputSchema.parse(input);
    await loadWorkflowVersion(this.versions, request);
    const run = workflowRunSchema.parse(await this.runs.createWithExecution(request));
    if (
      run.projectId !== request.projectId ||
      run.workflowId !== request.workflowId ||
      run.workflowVersionId !== request.workflowVersionId ||
      run.status !== 'pending'
    )
      throw new Error('新建运行与提交身份不匹配或不是 pending');
    return run;
  }

  async resume(input: ResumeWorkflowRunInput): Promise<ResumeWorkflowExecutionJob> {
    return this.runs.createResumeExecution(input);
  }
}
