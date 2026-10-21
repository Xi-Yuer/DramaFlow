import {
  saveWorkflowDraftRequestSchema,
  workflowIdentifierSchema,
  workflowResponseSchema,
  type WorkflowResponse,
} from '@dramaflow/contracts';
import { Prisma } from '@dramaflow/database';
import { DatabaseService } from '@dramaflow/server';
import {
  createWorkflowDefinitionSnapshot,
  NodeRegistry,
  workflowVersionRecordSchema,
  type WorkflowVersionRecord,
} from '@dramaflow/workflow';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { validateWorkflowNodeConfigurations } from './validate-node-configurations.js';
import { createInitialWorkflowData } from './initial-workflow.js';

const revisionSchema = z.number().int().positive();
const publishInputSchema = z
  .object({
    workflowId: workflowIdentifierSchema,
    expectedRevision: revisionSchema,
  })
  .strict();
const updateDraftInputSchema = saveWorkflowDraftRequestSchema.extend({
  workflowId: workflowIdentifierSchema,
});

export type UpdateWorkflowDraftInput = z.infer<typeof updateDraftInputSchema>;
export type PublishWorkflowInput = z.infer<typeof publishInputSchema>;
export type PublishWorkflowResult = WorkflowVersionRecord & {
  readonly sourceRevision: number;
};

function revisionConflict(): ConflictException {
  return new ConflictException({
    code: 'WORKFLOW_REVISION_CONFLICT',
    message: '工作流草稿已更新，请重新加载后再保存或发布',
  });
}

@Injectable()
export class WorkflowService {
  constructor(
    private readonly db: DatabaseService,
    private readonly registry: NodeRegistry,
  ) {}

  async initializeForProject(
    ownerId: string,
    rawProjectId: string,
  ): Promise<WorkflowResponse> {
    const projectId = z.uuid().parse(rawProjectId);
    return this.db.client.$transaction(
      async (tx) => {
        // 锁定项目而非尚不存在的 Workflow，串行化跨进程首次初始化，并固定本次权限。
        const projects = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "canvas_project"
          WHERE "id" = ${projectId}::uuid AND "ownerId" = ${ownerId}
          FOR UPDATE
        `;
        if (!projects[0]) throw new NotFoundException('项目不存在或无权访问');
        const existing = await tx.workflow.findUnique({ where: { projectId } });
        const workflow =
          existing ??
          (await tx.workflow.create({
            data: { projectId, ...createInitialWorkflowData() },
          }));
        // 已存在时不执行 UPDATE，不重置草稿、名称、revision 或 updatedAt。
        return this.response(workflow);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async getForProject(
    ownerId: string,
    rawProjectId: string,
  ): Promise<WorkflowResponse> {
    const projectId = z.uuid().parse(rawProjectId);
    const workflow = await this.db.client.workflow.findFirst({
      where: { projectId, project: { ownerId } },
    });
    if (!workflow) throw new NotFoundException('工作流不存在或无权访问');
    return this.response(workflow);
  }

  private response(
    workflow: Prisma.WorkflowGetPayload<Record<string, never>>,
  ): WorkflowResponse {
    return workflowResponseSchema.parse({
      id: workflow.id,
      projectId: workflow.projectId,
      name: workflow.name,
      revision: workflow.revision,
      draft: workflow.draft,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    });
  }

  async updateDraft(
    ownerId: string,
    input: unknown,
  ): Promise<{ revision: number }> {
    const request = updateDraftInputSchema.parse(input);
    validateWorkflowNodeConfigurations(
      request.definition,
      this.registry,
      'draft',
    );
    const draft = z.record(z.string(), z.json()).parse(request.definition);
    return this.db.client.$transaction(async (tx) => {
      // revision 与所有者共同约束原子 UPDATE，不先读草稿再无条件覆盖。
      const where = { id: request.workflowId, project: { ownerId } };
      const changed = await tx.workflow.updateMany({
        where: { ...where, revision: request.expectedRevision },
        data: { draft, revision: { increment: 1 } },
      });
      if (changed.count === 0) {
        const workflow = await tx.workflow.findFirst({
          where,
          select: { id: true },
        });
        if (!workflow) throw new NotFoundException('工作流不存在或无权访问');
        throw revisionConflict();
      }
      // 返回本次提交的修订，不读取可能已被后续编辑推进的 revision。
      return { revision: request.expectedRevision + 1 };
    });
  }

  async publish(
    ownerId: string,
    input: unknown,
  ): Promise<PublishWorkflowResult> {
    const request = publishInputSchema.parse(input);
    return this.db.client.$transaction(
      async (tx) => {
        // 行锁同时串行化发布序列，并与 UPDATE draft 的行锁互斥。
        // ReadCommitted 确保等待锁后检查的是已提交的新 revision，后续查询也能看到前次发布。
        const rows = await tx.$queryRaw<
          {
            id: string;
            projectId: string;
            revision: number;
            draft: unknown;
          }[]
        >`
        SELECT w."id", w."projectId", w."revision", w."draft"
        FROM "workflow" AS w
        JOIN "canvas_project" AS p ON p."id" = w."projectId"
        WHERE w."id" = ${request.workflowId} AND p."ownerId" = ${ownerId}
        FOR UPDATE OF w
      `;
        const workflow = rows[0];
        if (!workflow) throw new NotFoundException('工作流不存在或无权访问');
        if (workflow.revision !== request.expectedRevision)
          throw revisionConflict();

        const existing = await tx.workflowVersion.findUnique({
          where: {
            workflowId_sourceRevision: {
              workflowId: workflow.id,
              sourceRevision: workflow.revision,
            },
          },
          select: { id: true },
        });
        if (existing)
          throw new ConflictException({
            code: 'WORKFLOW_REVISION_ALREADY_PUBLISHED',
            message: '该草稿修订已发布，请勿重复发布',
          });

        // 此函数内部执行正式 workflowDefinitionSchema.parse 并冻结完整快照。
        // 数据库 draft 不因曾经保存成功而成为可信的运行定义。
        const snapshot = createWorkflowDefinitionSnapshot(workflow.draft);
        validateWorkflowNodeConfigurations(snapshot, this.registry, 'publish');
        const definition = z.record(z.string(), z.json()).parse(snapshot);
        const previous = await tx.workflowVersion.aggregate({
          where: { workflowId: workflow.id },
          _max: { version: true },
        });
        const row = await tx.workflowVersion.create({
          data: {
            workflowId: workflow.id,
            sourceRevision: workflow.revision,
            version: (previous._max.version ?? 0) + 1,
            definition,
          },
        });
        return {
          ...workflowVersionRecordSchema.parse({
            id: row.id,
            workflowId: row.workflowId,
            projectId: workflow.projectId,
            version: row.version,
            publishedAt: row.createdAt.toISOString(),
            definition: row.definition,
          }),
          sourceRevision: row.sourceRevision,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}
