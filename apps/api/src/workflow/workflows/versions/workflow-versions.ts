import {
  workflowIdentifierSchema,
  workflowVersionListQuerySchema,
  workflowVersionListResponseSchema,
  workflowVersionResponseSchema,
  type WorkflowVersionListResponse,
  type WorkflowVersionResponse,
} from '@dramaflow/contracts';
import type { DatabaseService } from '@dramaflow/server';
import { NotFoundException } from '@nestjs/common';

export class WorkflowVersions {
  constructor(private readonly db: DatabaseService) {}

  async listVersions(
    ownerId: string,
    rawWorkflowId: string,
    query: unknown,
  ): Promise<WorkflowVersionListResponse> {
    const workflowId = workflowIdentifierSchema.parse(rawWorkflowId);
    const { beforeVersion } = workflowVersionListQuerySchema.parse(query);
    const workflow = await this.db.client.workflow.findFirst({
      where: { id: workflowId, project: { ownerId } },
      select: { id: true },
    });
    if (!workflow) throw new NotFoundException('工作流不存在或无权访问');
    const rows = await this.db.client.workflowVersion.findMany({
      where: {
        workflowId,
        workflow: { project: { ownerId } },
        ...(beforeVersion ? { version: { lt: beforeVersion } } : {}),
      },
      orderBy: { version: 'desc' },
      take: 21,
      select: {
        id: true,
        workflowId: true,
        version: true,
        sourceRevision: true,
        createdAt: true,
        workflow: { select: { projectId: true } },
      },
    });
    const items = rows.slice(0, 20).map(({ workflow, createdAt, ...row }) => ({
      ...row,
      projectId: workflow.projectId,
      publishedAt: createdAt.toISOString(),
    }));
    return workflowVersionListResponseSchema.parse({
      items,
      nextBeforeVersion: rows.length > 20 ? items.at(-1)!.version : null,
    });
  }

  async getVersion(ownerId: string, rawVersionId: string): Promise<WorkflowVersionResponse> {
    const id = workflowIdentifierSchema.parse(rawVersionId);
    const row = await this.db.client.workflowVersion.findFirst({
      where: { id, workflow: { project: { ownerId } } },
      include: { workflow: { select: { projectId: true } } },
    });
    if (!row) throw new NotFoundException('工作流版本不存在或无权访问');
    return workflowVersionResponseSchema.parse({
      id: row.id,
      workflowId: row.workflowId,
      projectId: row.workflow.projectId,
      version: row.version,
      sourceRevision: row.sourceRevision,
      publishedAt: row.createdAt.toISOString(),
      definition: row.definition,
    });
  }
}
