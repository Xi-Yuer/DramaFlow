import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
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
  workflowExecutionJobSchema,
  type WorkflowExecutionJob,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  StorageService,
  WorkflowCheckpointerService,
  WorkflowExecutionQueue,
  workflowExecutionJobId,
} from '@dramaflow/server';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly checkpoints: WorkflowCheckpointerService,
    private readonly queue: WorkflowExecutionQueue,
  ) {}
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

  // 模型配置属于账号，不随项目删除。项目内的视频、工作流、运行和素材由外键级联删除。
  async remove(ownerId: string, rawId: string): Promise<void> {
    const id = z.string().uuid().parse(rawId);
    const removed = await this.db.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM canvas_project
        WHERE id = ${id}::uuid AND "ownerId" = ${ownerId}
        FOR UPDATE
      `;
      if (!rows[0]) return null;
      const artifacts = await tx.artifact.findMany({
        where: { projectId: id },
        select: { storageKey: true },
      });
      const runs = await tx.workflowRun.findMany({
        where: { projectId: id },
        select: {
          id: true,
          threadId: true,
          executions: { select: { payload: true } },
        },
      });
      await tx.project.delete({ where: { id } });
      return { artifacts, runs };
    });
    if (!removed) throw new NotFoundException('项目不存在或无权访问');

    const jobs = new Map<string, WorkflowExecutionJob>();
    for (const run of removed.runs) {
      const start = { kind: 'start' as const, workflowRunId: run.id };
      jobs.set(workflowExecutionJobId(start), start);
      for (const execution of run.executions) {
        const parsed = workflowExecutionJobSchema.safeParse(execution.payload);
        if (parsed.success) jobs.set(workflowExecutionJobId(parsed.data), parsed.data);
      }
    }
    let cleanupFailed = false;
    for (const artifact of removed.artifacts) {
      try {
        await this.storage.delete(artifact.storageKey);
      } catch {
        cleanupFailed = true;
      }
    }
    for (const threadId of new Set(removed.runs.map((run) => run.threadId))) {
      try {
        await this.checkpoints.deleteThread(threadId);
      } catch {
        cleanupFailed = true;
      }
    }
    for (const job of jobs.values()) {
      try {
        await this.queue.remove(job);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      throw new ServiceUnavailableException({
        code: 'PROJECT_CLEANUP_INCOMPLETE',
        message: '项目已删除，部分关联对象未能清理',
      });
    }
  }

  private dto(project: {
    id: string;
    name: string;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
  }) {
    // 协议是严格对象，不能把 ownerId 等内部字段带进响应。
    return projectSchema.parse({
      id: project.id,
      name: project.name,
      revision: project.revision,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    });
  }
}
