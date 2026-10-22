import type { ResumeWorkflowExecutionJob, WorkflowRun } from '@dramaflow/contracts';
import type { CreateWorkflowRunInput } from '../workflow-run-repository.js';

// 生产实现必须在同一事务提交业务记录和 Outbox，不允许先创建 Run 再单独写命令。
export interface WorkflowRunSubmissionRepository {
  createWithExecution(input: CreateWorkflowRunInput): Promise<{
    readonly run: WorkflowRun;
    readonly created: boolean;
  }>;
  createResumeExecution(input: {
    workflowRunId: string;
    value: unknown;
  }): Promise<ResumeWorkflowExecutionJob>;
}
