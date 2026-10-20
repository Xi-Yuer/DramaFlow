import { artifactSchema, dataTypeSchema, type Artifact } from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';
import type { ArtifactWriteContext, RuntimeValueDecodeContext } from '@dramaflow/workflow';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';

export interface ArtifactScope {
  readonly ownerId: string;
  readonly projectId: string;
  readonly workflowRunId: string;
}
export interface ArtifactWriteRecord {
  readonly id: string;
  readonly storageKey: string;
  readonly contentKind: 'json' | 'blob';
  readonly mimeType: string;
  readonly size: number;
  readonly checksum: string;
}

function toArtifact(row: Prisma.ArtifactGetPayload<Record<string, never>>): Artifact {
  return artifactSchema.parse({
    id: row.id,
    projectId: row.projectId,
    workflowRunId: row.workflowRunId,
    ...(row.nodeRunId ? { nodeRunId: row.nodeRunId } : {}),
    type: row.type,
    contentKind: row.contentKind,
    storage: {
      provider: 'rustfs',
      key: row.storageKey,
      mimeType: row.mimeType,
      size: row.size,
      checksum: row.checksum,
    },
    createdAt: row.createdAt.toISOString(),
  });
}

@Injectable()
export class ArtifactRepository {
  constructor(private readonly db: DatabaseService) {}

  private assertContext(scope: ArtifactScope, context: RuntimeValueDecodeContext) {
    if (scope.projectId !== context.projectId || scope.workflowRunId !== context.workflowRunId)
      throw new NotFoundException('产物不存在或无权访问');
  }

  async authorize(scope: ArtifactScope): Promise<void> {
    const run = await this.db.client.workflowRun.findFirst({
      where: {
        id: scope.workflowRunId,
        projectId: scope.projectId,
        project: { ownerId: scope.ownerId },
      },
      select: { id: true },
    });
    if (!run) throw new NotFoundException('运行不存在或无权访问');
  }

  async createWriting(
    scope: ArtifactScope,
    context: ArtifactWriteContext,
    record: ArtifactWriteRecord,
  ) {
    this.assertContext(scope, context);
    // 来源和授权在事务中核对，外键继续保证项目 / Run / NodeRun 不可拼接。
    await this.db.client.$transaction(async (tx) => {
      const run = await tx.workflowRun.findFirst({
        where: {
          id: scope.workflowRunId,
          projectId: scope.projectId,
          project: { ownerId: scope.ownerId },
          status: 'running',
        },
        select: { id: true },
      });
      if (!run) throw new NotFoundException('运行不存在、无权访问或未执行');
      if (context.nodeRunId) {
        const node = await tx.nodeRun.findFirst({
          where: {
            id: z.uuid().parse(context.nodeRunId),
            workflowRunId: scope.workflowRunId,
            projectId: scope.projectId,
            nodeId: context.nodeId,
            status: 'running',
          },
          select: { id: true },
        });
        if (!node) throw new NotFoundException('产物来源节点执行记录不匹配');
      }
      await tx.artifact.create({
        data: {
          ...record,
          projectId: scope.projectId,
          workflowRunId: scope.workflowRunId,
          nodeRunId: context.nodeRunId,
          nodeId: context.nodeId,
          outputKey: context.outputKey,
          type: z.record(z.string(), z.json()).parse(dataTypeSchema.parse(context.type)),
        },
      });
    });
  }

  async markReady(scope: ArtifactScope, id: string): Promise<void> {
    const changed = await this.db.client.artifact.updateMany({
      where: {
        id,
        projectId: scope.projectId,
        workflowRunId: scope.workflowRunId,
        project: { ownerId: scope.ownerId },
        status: 'writing',
      },
      data: { status: 'ready', completedAt: new Date() },
    });
    if (changed.count !== 1) throw new Error('产物写入状态不允许确认');
  }

  async markFailed(scope: ArtifactScope, id: string, cleanupRequired: boolean): Promise<void> {
    const changed = await this.db.client.artifact.updateMany({
      where: {
        id,
        projectId: scope.projectId,
        workflowRunId: scope.workflowRunId,
        project: { ownerId: scope.ownerId },
        status: 'writing',
      },
      data: { status: 'failed', failureStage: 'upload', cleanupRequired, completedAt: new Date() },
    });
    if (changed.count !== 1) throw new Error('产物写入失败状态未能记录');
  }

  async getReady(
    scope: ArtifactScope,
    id: string,
    context: RuntimeValueDecodeContext,
  ): Promise<Artifact> {
    this.assertContext(scope, context);
    await this.authorize(scope);
    const row = await this.db.client.artifact.findFirst({
      where: {
        id: z.uuid().parse(id),
        projectId: scope.projectId,
        project: { ownerId: scope.ownerId },
        status: 'ready',
      },
    });
    if (!row) throw new NotFoundException('产物不存在或无权访问');
    return toArtifact(row);
  }
}
