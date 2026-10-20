import type { RuntimeValue, WorkflowRun, WorkflowRunError } from '@dramaflow/contracts';

export interface CreateWorkflowRunInput {
  readonly projectId: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly inputs: Record<string, RuntimeValue>;
}

// 实现须校验项目权限、固定版本和输入快照，并原子检查领域状态转换。
// waiting 只是业务记录，不在 Repository 中执行、暂停或恢复 Graph。
export interface WorkflowRunRepository {
  create(input: CreateWorkflowRunInput): Promise<WorkflowRun>;
  markRunning(workflowRunId: string): Promise<void>;
  markWaiting(workflowRunId: string): Promise<void>;
  markCompleted(workflowRunId: string, outputs: Record<string, RuntimeValue>): Promise<void>;
  markFailed(workflowRunId: string, error: WorkflowRunError): Promise<void>;
  markCancelled(workflowRunId: string): Promise<void>;
}
