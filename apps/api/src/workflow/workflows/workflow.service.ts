import {
  saveWorkflowDraftRequestSchema,
  publishWorkflowRequestSchema,
  workflowIdentifierSchema,
  workflowResponseSchema,
  type WorkflowResponse,
  workflowVersionResponseSchema,
  workflowVersionListQuerySchema,
  workflowVersionListResponseSchema,
  type WorkflowVersionListResponse,
  type WorkflowVersionResponse,
} from '@dramaflow/contracts';
import { Prisma } from '@dramaflow/database';
import {
  DatabaseService,
  ModelProviderService,
  ModelConfigurationError,
} from '@dramaflow/server';
import {
  createWorkflowDefinitionSnapshot,
  NodeRegistry,
  workflowVersionRecordSchema,
  type WorkflowVersionRecord,
  validateWorkflowForPublish,
  WorkflowPublishValidationError,
  textGenerationConfigSchema,
} from '@dramaflow/workflow';
import {
  ConflictException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { validateWorkflowNodeConfigurations } from './validate-node-configurations.js';
import { createInitialWorkflowData } from './initial-workflow.js';

const publishInputSchema = publishWorkflowRequestSchema.extend({
  workflowId: workflowIdentifierSchema,
});
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
    private readonly models: ModelProviderService,
  ) {}

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

  async getVersion(
    ownerId: string,
    rawVersionId: string,
  ): Promise<WorkflowVersionResponse> {
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
    validateWorkflowNodeConfigurations(request.definition, this.registry);
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
        try {
          const nodes = validateWorkflowForPublish(snapshot, this.registry);
          for (const { node, nodeType, config } of nodes) {
            const requirements = nodeType.manifest.capabilities ?? [];
            if (requirements.length === 0) continue;
            // 当前正式能力节点只有文本生成；资源绑定规则属于应用层，不按 UI 控件推断。
            if (node.type !== 'ai.text_generate')
              throw new BadRequestException({
                code: 'WORKFLOW_CAPABILITY_BINDING_UNSUPPORTED',
                message: '节点能力绑定尚不支持发布',
              });
            const { modelConfigurationId } =
              textGenerationConfigSchema.parse(config);
            for (const capability of requirements)
              await this.models.assertPublishableConfiguration(
                tx,
                ownerId,
                modelConfigurationId,
                capability.type,
              );
          }
        } catch (error) {
          if (error instanceof WorkflowPublishValidationError) {
            if (error.code === 'NODE_CONFIG_INVALID')
              throw new BadRequestException({
                code: 'WORKFLOW_NODE_CONFIGURATION_INVALID',
                message: '工作流节点配置无效',
              });
            throw new BadRequestException({
              code: 'WORKFLOW_PUBLISH_VALIDATION_FAILED',
              message: error.message,
              issues: [
                {
                  code: error.code,
                  nodeId: error.nodeId,
                  ...(error.portKey === undefined
                    ? {}
                    : { portKey: error.portKey }),
                },
              ],
            });
          }
          if (error instanceof ModelConfigurationError)
            throw new BadRequestException({
              code: error.code,
              message: '发布所选模型配置无效或不可用',
            });
          throw error;
        }
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
