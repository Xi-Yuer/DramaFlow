import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  createVideoSchema,
  decodeVideoPageCursor,
  encodeVideoPageCursor,
  saveVideoSchema,
  videoListQuerySchema,
  videoSchema,
} from '@dramaflow/contracts';
import { DatabaseService } from '@dramaflow/server';
import { Prisma } from '@dramaflow/database';

@Injectable()
export class VideosService {
  constructor(private readonly db: DatabaseService) {}

  private async requireProject(ownerId: string, projectId: string) {
    const project = await this.db.client.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('项目不存在或无权访问');
  }

  async list(ownerId: string, rawProjectId: string, rawQuery: unknown) {
    const projectId = z.uuid().parse(rawProjectId);
    const { cursor: token } = videoListQuerySchema.parse(rawQuery);
    const cursor = token ? decodeVideoPageCursor(token) : undefined;
    await this.requireProject(ownerId, projectId);
    const rows = await this.db.client.video.findMany({
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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 31,
    });
    const page = rows.slice(0, 30);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.dto(row)),
      nextCursor:
        rows.length > 30 && last
          ? encodeVideoPageCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  async create(ownerId: string, rawProjectId: string, raw: unknown) {
    const projectId = z.uuid().parse(rawProjectId);
    const { name } = createVideoSchema.parse(raw);
    // 与 Project 删除共用行锁，权限与创建固定在同一事务；不创建 Workflow 或 Run。
    return this.db.client.$transaction(async (tx) => {
      const projects = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM canvas_project
        WHERE id = ${projectId}::uuid AND "ownerId" = ${ownerId}
        FOR UPDATE
      `;
      if (!projects[0]) throw new NotFoundException('项目不存在或无权访问');
      return this.dto(await tx.video.create({ data: { projectId, name } }));
    });
  }

  async get(ownerId: string, rawProjectId: string, rawId: string) {
    const projectId = z.uuid().parse(rawProjectId);
    const id = z.uuid().parse(rawId);
    const video = await this.db.client.video.findFirst({
      where: { id, projectId, project: { ownerId } },
    });
    if (!video) throw new NotFoundException('视频作品不存在或无权访问');
    return this.dto(video);
  }

  async save(ownerId: string, rawProjectId: string, rawId: string, raw: unknown) {
    const projectId = z.uuid().parse(rawProjectId);
    const id = z.uuid().parse(rawId);
    const input = saveVideoSchema.parse(raw);
    const updatedAt = new Date();
    const result = await this.db.client.video.updateMany({
      where: { id, projectId, project: { ownerId }, revision: input.revision },
      data: { name: input.name, status: input.status, revision: { increment: 1 }, updatedAt },
    });
    if (!result.count) {
      await this.get(ownerId, projectId, id);
      throw new ConflictException({
        code: 'VIDEO_REVISION_CONFLICT',
        message: '视频作品已在其他页面更新，请重新读取后再保存',
      });
    }
    // 只确认提交快照，不用可能已被下一次保存覆盖的记录拼接响应。
    return { revision: input.revision + 1, updatedAt: updatedAt.toISOString() };
  }

  async remove(ownerId: string, rawProjectId: string, rawId: string) {
    const projectId = z.uuid().parse(rawProjectId);
    const id = z.uuid().parse(rawId);
    const result = await this.db.client.video.deleteMany({
      where: { id, projectId, project: { ownerId } },
    });
    if (!result.count) throw new NotFoundException('视频作品不存在或无权访问');
  }

  private dto(record: Prisma.VideoGetPayload<object>) {
    return videoSchema.parse({
      id: record.id,
      projectId: record.projectId,
      name: record.name,
      status: record.status,
      revision: record.revision,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }
}
