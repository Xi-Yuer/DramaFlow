import { ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '@dramaflow/database';
import type { DatabaseService } from '@dramaflow/server';
import {
  createWorkflowRequestSchema,
  deleteWorkflowRequestSchema,
  saveWorkflowMetadataRequestSchema,
  workflowIdentifierSchema,
  workflowResponseSchema,
  workflowSummarySchema,
  workflowListQuerySchema,
  encodeWorkflowCursor,
  decodeWorkflowCursor,
} from '@dramaflow/contracts';
import { createInitialWorkflowData } from '../initial-workflow.js';

type Row = Prisma.WorkflowGetPayload<object>;
const summary = (row: Omit<Row, 'draft' | 'viewport'>) =>
  workflowSummarySchema.parse({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    revision: row.revision,
    metadataRevision: row.metadataRevision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
export const workflowResponse = (row: Row) =>
  workflowResponseSchema.parse({ ...summary(row), draft: row.draft, viewport: row.viewport });
function conflict() {
  return new ConflictException({
    code: 'WORKFLOW_METADATA_CONFLICT',
    message: '工作流已在其他页面更新，请重新读取后操作',
  });
}

export class WorkflowCollection {
  constructor(private readonly db: DatabaseService) {}
  private scope(ownerId: string, rawProject: string, rawWorkflow: string) {
    return {
      id: workflowIdentifierSchema.parse(rawWorkflow),
      projectId: z.uuid().parse(rawProject),
      project: { ownerId },
    };
  }
  private async requireProject(ownerId: string, projectId: string) {
    if (
      !(await this.db.client.project.findFirst({
        where: { id: projectId, ownerId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('项目不存在或无权访问');
  }
  async list(ownerId: string, rawProject: string, query: unknown) {
    const projectId = z.uuid().parse(rawProject);
    const { cursor: token } = workflowListQuerySchema.parse(query);
    const cursor = token ? decodeWorkflowCursor(token) : undefined;
    await this.requireProject(ownerId, projectId);
    const rows = await this.db.client.workflow.findMany({
      where: {
        projectId,
        project: { ownerId },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        projectId: true,
        name: true,
        revision: true,
        metadataRevision: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 31,
    });
    const page = rows.slice(0, 30),
      last = page.at(-1);
    return {
      items: page.map(summary),
      nextCursor:
        rows.length > 30 && last
          ? encodeWorkflowCursor({ id: last.id, createdAt: last.createdAt.toISOString() })
          : null,
    };
  }
  async create(ownerId: string, rawProject: string, body: unknown) {
    const projectId = z.uuid().parse(rawProject),
      { name } = createWorkflowRequestSchema.parse(body);
    return this.db.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM canvas_project WHERE id=${projectId}::uuid AND "ownerId"=${ownerId} FOR KEY SHARE`;
      if (!rows[0]) throw new NotFoundException('项目不存在或无权访问');
      return workflowResponse(
        await tx.workflow.create({ data: { projectId, ...createInitialWorkflowData(name) } }),
      );
    });
  }
  async get(ownerId: string, projectId: string, workflowId: string) {
    const row = await this.db.client.workflow.findFirst({
      where: this.scope(ownerId, projectId, workflowId),
    });
    if (!row) throw new NotFoundException('工作流不存在或无权访问');
    return workflowResponse(row);
  }
  async saveMetadata(ownerId: string, projectId: string, workflowId: string, body: unknown) {
    const where = this.scope(ownerId, projectId, workflowId),
      input = saveWorkflowMetadataRequestSchema.parse(body);
    return this.db.client.$transaction(async (tx) => {
      const changed = await tx.workflow.updateMany({
        where: { ...where, metadataRevision: input.expectedMetadataRevision },
        data: {
          name: input.name,
          ...(input.viewport ? { viewport: input.viewport } : {}),
          metadataRevision: { increment: 1 },
        },
      });
      const row = await tx.workflow.findFirst({
        where,
        select: { metadataRevision: true, updatedAt: true },
      });
      if (!row) throw new NotFoundException('工作流不存在或无权访问');
      if (!changed.count) throw conflict();
      return { metadataRevision: row.metadataRevision, updatedAt: row.updatedAt.toISOString() };
    });
  }
  async remove(ownerId: string, projectId: string, workflowId: string, body: unknown) {
    const where = this.scope(ownerId, projectId, workflowId),
      input = deleteWorkflowRequestSchema.parse(body);
    await this.db.client.$transaction(async (tx) => {
      const projects = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM canvas_project WHERE id=${where.projectId}::uuid AND "ownerId"=${ownerId} FOR KEY SHARE`;
      if (!projects[0]) throw new NotFoundException('项目不存在或无权访问');
      // 与正式 Publish / Draft 写入使用同一 Workflow 行锁；版本检查后不能并发插入已发布历史。
      const rows = await tx.$queryRaw<
        { revision: number; metadataRevision: number }[]
      >`SELECT revision,"metadataRevision" FROM workflow WHERE id=${where.id} AND "projectId"=${where.projectId}::uuid FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new NotFoundException('工作流不存在或无权访问');
      if (
        row.revision !== input.expectedRevision ||
        row.metadataRevision !== input.expectedMetadataRevision
      )
        throw conflict();
      const [version, run] = await Promise.all([
        tx.workflowVersion.findFirst({ where: { workflowId: where.id }, select: { id: true } }),
        tx.workflowRun.findFirst({ where: { workflowId: where.id }, select: { id: true } }),
      ]);
      if (version || run)
        throw new ConflictException({
          code: 'WORKFLOW_HAS_HISTORY',
          message: '工作流已有已发布版本或运行历史，不能删除；历史版本、运行和产物必须保留',
        });
      await tx.workflow.delete({ where: { id: where.id } });
    });
  }
}
