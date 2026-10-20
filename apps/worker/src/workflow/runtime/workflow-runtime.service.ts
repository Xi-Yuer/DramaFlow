import type {
  WorkflowExecutionJob,
  ResumeWorkflowExecutionJob,
} from '@dramaflow/contracts';
import { WorkflowExecutionService } from '@dramaflow/server';
import { Injectable } from '@nestjs/common';

// 后续 Consumer 只交付 Job；Worker 执行已有 Run，不创建第二条运行记录。
@Injectable()
export class WorkflowRuntimeService {
  constructor(private readonly execution: WorkflowExecutionService) {}

  execute(job: WorkflowExecutionJob) {
    return this.execution.execute(job);
  }

  executeStart(workflowRunId: string) {
    return this.execution.executeStart(workflowRunId);
  }

  executeResume(input: ResumeWorkflowExecutionJob) {
    return this.execution.executeResume(input);
  }
}
