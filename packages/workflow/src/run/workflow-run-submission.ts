import {
  runtimeValueMapSchema,
  workflowIdentifierSchema,
  workflowRunSchema,
  workflowExecutionJobSchema,
  type WorkflowRun,
  type ResumeWorkflowExecutionJob,
} from '@dramaflow/contracts';
import { z } from 'zod';
import { WorkflowRunNotWaitingError } from './workflow-run-error.js';
import type { WorkflowRunRepository } from './workflow-run-repository.js';
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

// 本层不执行 Graph、不抢占状态，也不承诺意图已持久入队；调用方须把意图交给执行适配层。
export class DefaultWorkflowRunSubmissionService implements WorkflowRunSubmissionService {
  constructor(
    private readonly versions: WorkflowVersionRepository,
    private readonly runs: WorkflowRunRepository,
  ) {}

  async start(input: StartWorkflowRunInput): Promise<WorkflowRun> {
    const request = startInputSchema.parse(input);
    await loadWorkflowVersion(this.versions, request);
    const run = workflowRunSchema.parse(await this.runs.create(request));
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
    const job = workflowExecutionJobSchema.parse({ ...input, kind: 'resume' });
    if (job.kind !== 'resume') throw new Error('恢复意图类型错误');
    const stored = await this.runs.getById(job.workflowRunId);
    if (!stored || stored.status !== 'waiting')
      throw new WorkflowRunNotWaitingError(job.workflowRunId);
    const run = workflowRunSchema.parse(stored);
    if (run.id !== job.workflowRunId) throw new Error('读取到的运行与恢复请求不匹配');
    return job;
  }
}
