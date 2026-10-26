import { workflowIdentifierSchema } from '@dramaflow/contracts';
import { DatabaseService } from '../database/database.service.js';
import {
  workflowVersionRecordSchema,
  type WorkflowVersionRecord,
  type WorkflowVersionRepository,
} from '@dramaflow/workflow';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';

interface RepositoryScope {
  readonly ownerId: string;
  readonly projectId: string;
}

class PrismaWorkflowVersionRepository implements WorkflowVersionRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly scope: RepositoryScope,
  ) {}

  async getVersion(workflowVersionId: string): Promise<WorkflowVersionRecord | null> {
    // 每次查询重新检查归属，旧 Repository 不能保留项目转移前的访问权限。
    const row = await this.db.client.workflowVersion.findFirst({
      where: {
        id: workflowIdentifierSchema.parse(workflowVersionId),
        workflow: {
          projectId: this.scope.projectId,
          project: { ownerId: this.scope.ownerId },
        },
      },
      select: {
        id: true,
        workflowId: true,
        version: true,
        definition: true,
        createdAt: true,
        workflow: { select: { projectId: true } },
      },
    });
    if (!row) return null;
    return workflowVersionRecordSchema.parse({
      id: row.id,
      workflowId: row.workflowId,
      projectId: row.workflow.projectId,
      version: row.version,
      // 版本创建即保存发布快照；对外沿用既有 publishedAt 契约。
      publishedAt: row.createdAt.toISOString(),
      definition: row.definition,
    });
  }
}

// 发布、版本号分配和草稿更新不属于此接口。
@Injectable()
export class WorkflowVersionRepositories {
  constructor(private readonly db: DatabaseService) {}

  async findOwnedWorkflow(
    ownerId: string,
    rawVersionId: string,
  ): Promise<{ projectId: string; workflowId: string } | null> {
    const version = await this.db.client.workflowVersion.findFirst({
      where: {
        id: workflowIdentifierSchema.parse(rawVersionId),
        workflow: { project: { ownerId } },
      },
      select: { workflow: { select: { id: true, projectId: true } } },
    });
    if (!version) return null;
    return { projectId: version.workflow.projectId, workflowId: version.workflow.id };
  }

  async forProject(ownerId: string, rawProjectId: string): Promise<WorkflowVersionRepository> {
    const projectId = z.uuid().parse(rawProjectId);
    const project = await this.db.client.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('项目不存在或无权访问');
    return new PrismaWorkflowVersionRepository(this.db, { ownerId, projectId });
  }
}
