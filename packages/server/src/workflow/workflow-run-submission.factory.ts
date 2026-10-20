import {
  DefaultWorkflowRunSubmissionService,
  type WorkflowRunSubmissionService,
} from '@dramaflow/workflow';
import { Injectable } from '@nestjs/common';
import { WorkflowRunRepositories } from './workflow-run-repository.js';
import { WorkflowVersionRepositories } from './workflow-version-repository.js';

// 提交只需要业务存储，不构造 Compiler、Runner 或 Checkpointer。
@Injectable()
export class WorkflowRunSubmissionFactory {
  constructor(
    private readonly versions: WorkflowVersionRepositories,
    private readonly runs: WorkflowRunRepositories,
  ) {}

  async forProject(ownerId: string, projectId: string): Promise<WorkflowRunSubmissionService> {
    return new DefaultWorkflowRunSubmissionService(
      await this.versions.forProject(ownerId, projectId),
      await this.runs.forProject(ownerId, projectId),
    );
  }
}
