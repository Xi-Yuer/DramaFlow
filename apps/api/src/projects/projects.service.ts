import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createProjectSchema,
  decodeProjectPageCursor,
  encodeProjectPageCursor,
  saveProjectSchema,
  projectListQuerySchema,
  projectSchema,
  projectSummarySchema,
} from '@dramaflow/contracts';
import { DatabaseService } from '@dramaflow/server';
import { createInitialWorkflowData } from '../workflow/workflows/initial-workflow.js';

@Injectable()
export class ProjectsService {
  constructor(private readonly db: DatabaseService) {}
  async list(ownerId: string, query: unknown) {
    const { cursor: rawCursor } = projectListQuerySchema.parse(query);
    const cursor = rawCursor ? decodeProjectPageCursor(rawCursor) : undefined;
    const items = await this.db.client.project.findMany({
      where: cursor
        ? {
            ownerId,
            OR: [
              { updatedAt: { lt: new Date(cursor.updatedAt) } },
              { updatedAt: new Date(cursor.updatedAt), id: { lt: cursor.id } },
            ],
          }
        : { ownerId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 31,
      select: {
        id: true,
        name: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const page = items.slice(0, 30);
    const last = page.at(-1);
    return {
      items: page.map((item) =>
        projectSummarySchema.parse({
          ...item,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        }),
      ),
      nextCursor:
        items.length > 30 && last
          ? encodeProjectPageCursor({
              updatedAt: last.updatedAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }
  async create(ownerId: string, raw: unknown) {
    const { name } = createProjectSchema.parse(raw);
    const project = await this.db.client.project.create({
      data: {
        ownerId,
        name,
        viewport: { x: 0, y: 0, zoom: 1 },
        // 嵌套创建与 Project 原子提交；不会留下没有默认 Workflow 的新项目。
        workflow: { create: createInitialWorkflowData() },
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
    // 所有者与修订号一并约束原子写入；不先读后无条件更新。
    const changed = await this.db.client.project.updateMany({
      where: { id, ownerId, revision: input.revision },
      data: {
        name: input.name,
        viewport: input.viewport,
        revision: { increment: 1 },
      },
    });
    if (!changed.count) {
      await this.get(ownerId, id);
      throw new ConflictException({
        code: 'REVISION_CONFLICT',
        message: '项目已在其他页面更新，请保留当前内容并重新加载',
      });
    }
    // 响应使用本次写入的 revision，不读取可能已被下一次写入覆盖的内容。
    return { revision: input.revision + 1 };
  }
  private dto(project: {
    id: string;
    name: string;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
    viewport: unknown;
  }) {
    // 协议是严格对象，不能把 ownerId 等内部字段带进响应。
    return projectSchema.parse({
      id: project.id,
      name: project.name,
      revision: project.revision,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      viewport: project.viewport,
    });
  }
}
