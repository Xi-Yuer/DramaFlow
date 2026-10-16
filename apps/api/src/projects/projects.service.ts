import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createProjectSchema,
  saveProjectSchema,
  projectSchema,
  projectSummarySchema,
  emptyWorkflow,
} from '@dramaflow/contracts';
import { validateNodePlugins } from '@dramaflow/contracts';
import { systemPlugins } from '@dramaflow/plugins';
import { createFoundationRegistry } from '@dramaflow/workflow';
import { DatabaseService } from '../infrastructure/database.service.js';

@Injectable()
export class ProjectsService {
  private readonly registry = createFoundationRegistry();
  constructor(private readonly db: DatabaseService) {}
  catalog() {
    return { items: this.registry.catalog() };
  }
  async list(ownerId: string, query: unknown) {
    const { cursor } = z
      .object({ cursor: z.string().uuid().optional() })
      .strict()
      .parse(query);
    const items = await this.db.client.project.findMany({
      where: { ownerId, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: 31,
      select: {
        id: true,
        name: true,
        revision: true,
        nodeCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const hasMore = items.length > 30;
    return {
      items: items.slice(0, 30).map((item) =>
        projectSummarySchema.parse({
          ...item,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        }),
      ),
      nextCursor: hasMore ? items[29]!.id : null,
    };
  }
  async create(ownerId: string, raw: unknown) {
    const { name } = createProjectSchema.parse(raw);
    const project = await this.db.client.project.create({
      data: {
        ownerId,
        name,
        definition: emptyWorkflow(),
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    return this.dto(project);
  }
  async get(ownerId: string, rawId: string) {
    const id = z.string().uuid().parse(rawId);
    const project = await this.db.client.project.findFirst({
      where: { id, ownerId },
    });
    if (!project) throw new NotFoundException('项目不存在或无权访问');
    return this.dto(project);
  }
  async save(ownerId: string, rawId: string, raw: unknown) {
    const id = z.string().uuid().parse(rawId);
    const input = saveProjectSchema.parse(raw);
    const installations = await this.db.client.pluginInstallation.findMany({
      where: { ownerId },
      select: { id: true, pluginId: true },
    });
    const issues = [
      ...this.registry.validate(input.definition),
      ...validateNodePlugins(
        input.definition,
        this.registry.catalog(),
        installations,
        systemPlugins,
      ),
    ];
    if (issues.length)
      throw new BadRequestException({
        code: 'INVALID_WORKFLOW',
        message: issues.map((i) => i.message).join('；'),
        issues,
      });
    // 所有者与版本一并约束原子写入；不先读后无条件更新。
    const changed = await this.db.client.project.updateMany({
      where: { id, ownerId, revision: input.revision },
      data: {
        name: input.name,
        definition: input.definition,
        viewport: input.viewport,
        nodeCount: input.definition.nodes.length,
        revision: { increment: 1 },
      },
    });
    if (!changed.count) {
      await this.get(ownerId, id);
      throw new ConflictException({
        code: 'REVISION_CONFLICT',
        message: '项目已在其他页面更新，请保留当前内容并重新加载最新版本',
      });
    }
    // 成功响应使用本次写入的定义与 revision，不读取可能已被下一次写入覆盖的内容。
    return { revision: input.revision + 1 };
  }
  private dto(project: {
    id: string;
    name: string;
    revision: number;
    nodeCount: number;
    createdAt: Date;
    updatedAt: Date;
    definition: unknown;
    viewport: unknown;
  }) {
    // 协议是严格对象，不能把 ownerId 等内部字段带进响应。
    return projectSchema.parse({
      id: project.id,
      name: project.name,
      revision: project.revision,
      nodeCount: project.nodeCount,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      definition: project.definition,
      viewport: project.viewport,
    });
  }
}
