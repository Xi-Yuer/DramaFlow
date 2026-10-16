import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  createWorkflowSchema,
  emptyWorkflowDefinition,
  saveDraftSchema,
  workflowDefinitionSchema,
  type WorkflowDraft,
  type WorkflowSummary,
  type WorkflowVersion,
} from '@dramaflow/contracts';
import { validateWorkflow } from '@dramaflow/workflow';
import { DatabaseService } from '../infrastructure/database.service.js';
import { AccessService } from '../auth/access.service.js';
import { json, parse } from '../infrastructure/validation.js';

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
  ) {}
  async list(
    userId: string,
    workspaceId: string,
  ): Promise<{ items: WorkflowSummary[] }> {
    await this.access.workspace(userId, workspaceId);
    const rows = await this.db.client.workflow.findMany({
      where: { workspaceId },
      include: { versions: { orderBy: { number: 'desc' }, take: 1 } },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        workspaceId,
        name: row.name,
        description: row.description,
        revision: row.draftRevision,
        publishedVersionId: row.versions[0]?.id ?? null,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }
  async create(
    userId: string,
    workspaceId: string,
    body: unknown,
  ): Promise<WorkflowDraft> {
    await this.access.workspace(userId, workspaceId, 'editor');
    const input = parse(createWorkflowSchema, body);
    const row = await this.db.client.workflow.create({
      data: { workspaceId, ...input, draft: json(emptyWorkflowDefinition) },
    });
    return this.get(userId, row.id);
  }
  async get(userId: string, workflowId: string): Promise<WorkflowDraft> {
    const row = await this.access.workflow(userId, workflowId);
    const latest = await this.db.client.workflowVersion.findFirst({
      where: { workflowId },
      orderBy: { number: 'desc' },
    });
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      description: row.description,
      revision: row.draftRevision,
      definition: parse(workflowDefinitionSchema, row.draft),
      publishedVersionId: latest?.id ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  async save(
    userId: string,
    workflowId: string,
    body: unknown,
  ): Promise<WorkflowDraft> {
    await this.access.workflow(userId, workflowId, 'editor');
    const input = parse(saveDraftSchema, body);
    const update = await this.db.client.workflow.updateMany({
      where: { id: workflowId, draftRevision: input.revision },
      data: {
        name: input.name,
        description: input.description,
        draft: json(input.definition),
        draftRevision: { increment: 1 },
      },
    });
    if (update.count !== 1)
      throw new ConflictException('工作流已修改，请刷新后重新应用');
    return this.get(userId, workflowId);
  }
  async validate(userId: string, workflowId: string, body?: unknown) {
    const draft = await this.get(userId, workflowId);
    const definition =
      body && typeof body === 'object' && 'definition' in body
        ? parse(workflowDefinitionSchema, body.definition)
        : draft.definition;
    return validateWorkflow(definition);
  }
  async publish(userId: string, workflowId: string): Promise<WorkflowVersion> {
    await this.access.workflow(userId, workflowId, 'editor');
    const row = await this.db.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workflow" WHERE id = ${workflowId} FOR UPDATE`;
      const workflow = await tx.workflow.findUniqueOrThrow({
        where: { id: workflowId },
      });
      const definition = parse(workflowDefinitionSchema, workflow.draft);
      const validation = validateWorkflow(definition);
      if (!validation.valid)
        throw new BadRequestException({
          message: '工作流验证失败',
          issues: validation.issues,
        });
      const latest = await tx.workflowVersion.findFirst({
        where: { workflowId },
        orderBy: { number: 'desc' },
      });
      return tx.workflowVersion.create({
        data: {
          workflowId,
          number: (latest?.number ?? 0) + 1,
          definition: json(definition),
          publishedBy: userId,
          sourceRevision: workflow.draftRevision,
        },
      });
    });
    return {
      id: row.id,
      workflowId,
      number: row.number,
      definition: parse(workflowDefinitionSchema, row.definition),
      createdAt: row.createdAt.toISOString(),
    };
  }
  async versions(
    userId: string,
    workflowId: string,
  ): Promise<{ items: WorkflowVersion[] }> {
    await this.access.workflow(userId, workflowId);
    const rows = await this.db.client.workflowVersion.findMany({
      where: { workflowId },
      orderBy: { number: 'desc' },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        workflowId,
        number: row.number,
        definition: parse(workflowDefinitionSchema, row.definition),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
}
