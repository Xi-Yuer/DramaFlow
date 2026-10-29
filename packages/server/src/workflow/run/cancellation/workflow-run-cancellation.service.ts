import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  cancelWorkflowRunRequestSchema,
  cancelWorkflowRunResponseSchema,
  workflowIdentifierSchema,
} from '@dramaflow/contracts';
import { DatabaseService } from '../../../database/database.service.js';
import { WorkflowRunRepositories } from '../repository/workflow-run-repository.js';
import { WorkflowRunQueryService } from '../query/workflow-run-query.service.js';

@Injectable()
export class WorkflowRunCancellationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repositories: WorkflowRunRepositories,
    private readonly queries: WorkflowRunQueryService,
  ) {}
  async cancel(
    ownerId: string,
    rawProjectId: string,
    rawWorkflowId: string,
    rawRunId: string,
    body: unknown,
  ) {
    const projectId = z.uuid().parse(rawProjectId);
    const workflowId = workflowIdentifierSchema.parse(rawWorkflowId);
    const runId = workflowIdentifierSchema.parse(rawRunId);
    cancelWorkflowRunRequestSchema.parse(body === undefined ? {} : body);
    const workflow = await this.db.client.workflow.findFirst({
      where: { id: workflowId, projectId, project: { ownerId } },
      select: { id: true },
    });
    const run =
      workflow &&
      (await this.db.client.workflowRun.findFirst({
        where: { id: runId, workflowId, projectId, project: { ownerId } },
        select: { id: true },
      }));
    if (!run)
      throw new NotFoundException({
        code: 'WORKFLOW_RUN_NOT_FOUND',
        message: '工作流运行不存在或无权访问',
      });
    const repository = await this.repositories.forProject(ownerId, projectId);
    await repository.requestCancellation(run.id);
    // 请求与收尾可能竞争；始终返回最新的授权读模型，而非据请求结果伪造终态。
    const latest = await this.queries.getRun(ownerId, run.id);
    return cancelWorkflowRunResponseSchema.parse({
      outcome:
        latest.status === 'cancelled'
          ? 'cancelled'
          : ['completed', 'failed'].includes(latest.status)
            ? 'terminal'
            : 'requested',
      run: latest,
    });
  }
}
