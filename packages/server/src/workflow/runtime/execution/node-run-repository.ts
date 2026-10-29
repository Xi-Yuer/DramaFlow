import type { WorkflowExecutionCancellation } from '@dramaflow/workflow';
import { workflowIdentifierSchema } from '@dramaflow/contracts';
import type { HumanReviewNodeRunRepository, IterationRunRepository } from '@dramaflow/workflow';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../../database/database.service.js';
import { PrismaNodeRunRepository } from './nodes/prisma-node-run-repository.js';

// 不提供未限定项目 / 运行的公开 Repository 实例，也不增加 HTTP 运行入口。
@Injectable()
export class NodeRunRepositories {
  constructor(private readonly db: DatabaseService) {}

  async forRun(
    ownerId: string,
    rawProjectId: string,
    rawWorkflowRunId: string,
    cancellation?: WorkflowExecutionCancellation,
  ): Promise<HumanReviewNodeRunRepository & IterationRunRepository> {
    const projectId = z.uuid().parse(rawProjectId);
    const workflowRunId = workflowIdentifierSchema.parse(rawWorkflowRunId);
    if (cancellation && cancellation.workflowRunId !== workflowRunId)
      throw new Error('取消上下文与当前 Run 不匹配');
    const run = await this.db.client.workflowRun.findFirst({
      where: { id: workflowRunId, projectId, project: { ownerId } },
      select: { id: true },
    });
    if (!run) throw new NotFoundException('运行不存在或无权访问');
    return new PrismaNodeRunRepository(this.db, {
      ownerId,
      projectId,
      workflowRunId,
      ...(cancellation ? { cancellation } : {}),
    });
  }
}
