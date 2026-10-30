import {
  DefaultWorkflowRunSubmissionService,
  type WorkflowRunSubmissionService,
  type StartWorkflowRunInput,
} from '@dramaflow/workflow';
import type { WorkflowRun } from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';
import { Injectable } from '@nestjs/common';
import { WorkflowRunRepositories } from '../repository/workflow-run-repository.js';
import { WorkflowVersionRepositories } from '../repository/workflow-version-repository.js';

// 提交只需要业务存储，不构造 Compiler、Runner 或 Checkpointer。
@Injectable()
export class WorkflowRunSubmissionFactory {
  constructor(
    private readonly versions: WorkflowVersionRepositories,
    private readonly runs: WorkflowRunRepositories,
  ) {}

  inProjectStartTransaction<T>(
    ownerId: string,
    projectId: string,
    operation: (
      tx: Prisma.TransactionClient,
      start: (input: StartWorkflowRunInput) => Promise<{ run: WorkflowRun; created: boolean }>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.runs.inStartTransaction(ownerId, projectId, async (tx, runs) => {
      const versions = this.versions.forTransaction(ownerId, projectId, tx);
      return operation(tx, async (input) => {
        let created = false;
        const submission = new DefaultWorkflowRunSubmissionService(versions, {
          createWithExecution: async (invocation) => {
            const result = await runs.createWithExecution(invocation);
            created = result.created;
            return result;
          },
          createResumeExecution: (request) => runs.createResumeExecution(request),
        });
        const run = await submission.start(input);
        return { run, created };
      });
    });
  }

  async forProject(ownerId: string, projectId: string): Promise<WorkflowRunSubmissionService> {
    return new DefaultWorkflowRunSubmissionService(
      await this.versions.forProject(ownerId, projectId),
      await this.runs.forProject(ownerId, projectId),
    );
  }
}
