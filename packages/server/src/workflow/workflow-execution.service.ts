import { workflowExecutionJobSchema, type WorkflowExecutionJob } from '@dramaflow/contracts';
import type { ResumeWorkflowRunInput } from '@dramaflow/workflow';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { WorkflowRuntimeFactory } from './workflow-runtime.factory.js';

// 受信任的执行端入口，不能直接作为 HTTP 权限入口；调用前必须完成提交者权限校验。
// Job 不是 State 副本，执行所需项目权限范围、版本和 thread 都从数据库恢复。
@Injectable()
export class WorkflowExecutionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly runtimes: WorkflowRuntimeFactory,
  ) {}

  executeStart(workflowRunId: string) {
    return this.execute({ kind: 'start', workflowRunId });
  }

  executeResume(input: ResumeWorkflowRunInput) {
    return this.execute({ ...input, kind: 'resume' });
  }

  async execute(input: WorkflowExecutionJob) {
    const job = workflowExecutionJobSchema.parse(input);
    const run = await this.database.client.workflowRun.findUnique({
      where: { id: job.workflowRunId },
      select: { projectId: true, project: { select: { ownerId: true } } },
    });
    if (!run) throw new NotFoundException('工作流运行不存在');
    const runner = await this.runtimes.forProject(run.project.ownerId, run.projectId);
    return job.kind === 'start'
      ? runner.executeStart(job.workflowRunId)
      : runner.executeResume({ workflowRunId: job.workflowRunId, value: job.value });
  }
}
