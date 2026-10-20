export class WorkflowRunNotWaitingError extends Error {
  readonly code = 'WORKFLOW_RUN_NOT_WAITING';
  constructor(public readonly workflowRunId: string) {
    super('工作流运行不存在、无权访问或已不在 waiting 状态');
    this.name = 'WorkflowRunNotWaitingError';
  }
}

export class WorkflowRunNotPendingError extends Error {
  readonly code = 'WORKFLOW_RUN_NOT_PENDING';
  constructor(public readonly workflowRunId: string) {
    super('工作流运行不存在、无权访问或已不在 pending 状态');
    this.name = 'WorkflowRunNotPendingError';
  }
}

export class WorkflowResumeAlreadySubmittedError extends Error {
  readonly code = 'WORKFLOW_RESUME_ALREADY_SUBMITTED';
  constructor() {
    super('本轮等待已提交恢复请求');
    this.name = 'WorkflowResumeAlreadySubmittedError';
  }
}
