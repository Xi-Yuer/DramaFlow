import {
  runtimeValueMapSchema,
  workflowIdentifierSchema,
  workflowRunSchema,
  workflowInvocationKeySchema,
  type WorkflowRun,
  type ResumeWorkflowExecutionJob,
} from '@dramaflow/contracts';
import { z } from 'zod';
import { WorkflowInvocationContractValidator } from '../../definition/validate-invocation.js';
import type { WorkflowRunSubmissionRepository } from './workflow-run-submission-repository.js';
import { isWorkflowInvocationEquivalent } from './workflow-invocation-equivalence.js';
import { WorkflowInvocationConflictError } from '../workflow-run-error.js';
import {
  loadWorkflowVersion,
  type WorkflowVersionRepository,
} from '../workflow-version-repository.js';

const startInputSchema = z
  .object({
    projectId: workflowIdentifierSchema,
    workflowId: workflowIdentifierSchema,
    workflowVersionId: workflowIdentifierSchema,
    invocationKey: workflowInvocationKeySchema,
    inputs: runtimeValueMapSchema,
  })
  .strict();
export type StartWorkflowRunInput = z.infer<typeof startInputSchema>;
export interface ResumeWorkflowRunInput {
  readonly workflowRunId: string;
  readonly value: unknown;
  readonly interruptId?: string;
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
    private readonly invocationContract = new WorkflowInvocationContractValidator(),
  ) {}

  async start(input: StartWorkflowRunInput): Promise<WorkflowRun> {
    const request = startInputSchema.parse(input);
    const version = await loadWorkflowVersion(this.versions, request);
    const inputs = this.invocationContract.validate(version.definition.inputs, request.inputs);
    const invocation = { ...request, inputs };
    const result = await this.runs.createWithExecution(invocation);
    const run = workflowRunSchema.parse(result.run);
    if (
      run.projectId !== request.projectId ||
      run.workflowId !== request.workflowId ||
      run.invocationKey !== request.invocationKey ||
      (result.created && run.status !== 'pending')
    )
      throw new Error('新建运行与提交身份不匹配或不是 pending');
    if (!isWorkflowInvocationEquivalent(run, invocation))
      throw new WorkflowInvocationConflictError(run.id);
    return run;
  }

  async resume(input: ResumeWorkflowRunInput): Promise<ResumeWorkflowExecutionJob> {
    return this.runs.createResumeExecution(input);
  }
}
