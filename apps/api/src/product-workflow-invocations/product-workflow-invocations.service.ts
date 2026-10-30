import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  startProductWorkflowInvocationSchema,
  productWorkflowInvocationSchema,
  productWorkflowInvocationListQuerySchema,
  decodeProductInvocationCursor,
  encodeProductInvocationCursor,
  workflowInvocationKeySchema,
  type ProductWorkflowInvocation,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  WorkflowRunSubmissionFactory,
  WorkflowVersionRepositories,
} from '@dramaflow/server';
import type { Prisma } from '@dramaflow/database';
import { WorkflowRuntimeService } from '../workflow/runs/workflow-runtime.service.js';
import {
  workflowResourceNotFound,
  workflowRuntimeHttpError,
} from '../workflow/runs/workflow-runtime-http-error.js';

function sourceConflict() {
  return new ConflictException({
    code: 'PRODUCT_WORKFLOW_INVOCATION_CONFLICT',
    message: '该调用标识已用于其他来源或运行，不能改挂视频作品',
  });
}

@Injectable()
export class ProductWorkflowInvocationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly submissions: WorkflowRunSubmissionFactory,
    private readonly versions: WorkflowVersionRepositories,
    private readonly runtime: WorkflowRuntimeService,
  ) {}

  async start(ownerId: string, rawProjectId: string, rawVideoId: string, body: unknown) {
    const projectId = z.uuid().parse(rawProjectId),
      videoId = z.uuid().parse(rawVideoId);
    const request = startProductWorkflowInvocationSchema.parse(body);
    const version = await this.versions.findOwnedWorkflow(ownerId, request.workflowVersionId);
    if (!version || version.projectId !== projectId)
      throw workflowResourceNotFound('WORKFLOW_VERSION_NOT_FOUND');
    const accepted = await this.submissions
      .inProjectStartTransaction(ownerId, projectId, async (tx, start) => {
        // 同时保护当前来源和 Project 生命周期；名称只是受理时的历史显示快照。
        const videos = await tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT v.id, v.name FROM video v JOIN canvas_project p ON p.id = v."projectId"
        WHERE v.id = ${videoId}::uuid AND v."projectId" = ${projectId}::uuid AND p."ownerId" = ${ownerId}
        FOR KEY SHARE OF v, p
      `;
        const video = videos[0];
        if (!video) throw new NotFoundException('视频作品不存在或无权访问');
        const lock = JSON.stringify([
          'product-workflow-invocation',
          projectId,
          request.invocationKey,
        ]);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
        const existing = await tx.productWorkflowInvocation.findUnique({
          where: {
            projectId_invocationKey: { projectId, invocationKey: request.invocationKey },
          },
        });
        if (existing && existing.sourceVideoId !== videoId) throw sourceConflict();
        // 版本、输入、调用等价性、Run 和 Outbox 均复用正式 Submission；外层事务尚未提交。
        const result = await start({ ...request, projectId, workflowId: version.workflowId });
        if (existing) {
          if (existing.workflowRunId !== result.run.id) throw sourceConflict();
          return { invocation: this.dto(existing), run: result.run };
        }
        // 普通 Canvas Run 没有产品来源，不能通过复用 key 将其解释为此次产品调用。
        if (!result.created) throw sourceConflict();
        const invocation = await tx.productWorkflowInvocation.create({
          data: {
            projectId,
            sourceVideoId: videoId,
            sourceVideoName: video.name,
            workflowRunId: result.run.id,
            invocationKey: request.invocationKey,
          },
        });
        return { invocation: this.dto(invocation), run: result.run };
      })
      .catch((error: unknown) => {
        if (error instanceof HttpException) throw error;
        throw workflowRuntimeHttpError(error, 'WORKFLOW_VERSION_NOT_FOUND');
      });
    // 只有整个事务已提交后，才允许既有 Dispatcher 确认入队。
    try {
      const run = await this.runtime.dispatchAcceptedStart(accepted.run);
      return { invocation: accepted.invocation, run };
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 503) {
        throw new ServiceUnavailableException({
          code: 'WORKFLOW_QUEUE_UNAVAILABLE',
          message: '产品调用与运行已受理，入队结果尚未确认，请查询此次调用',
          workflowRunId: accepted.run.id,
          invocationKey: request.invocationKey,
          productWorkflowInvocationId: accepted.invocation.id,
        });
      }
      throw error;
    }
  }

  private async requireProject(ownerId: string, projectId: string) {
    const project = await this.db.client.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('项目不存在或无权访问');
  }

  async listForVideo(ownerId: string, rawProjectId: string, rawVideoId: string, query: unknown) {
    const projectId = z.uuid().parse(rawProjectId),
      sourceVideoId = z.uuid().parse(rawVideoId);
    const { cursor: token } = productWorkflowInvocationListQuerySchema.parse(query);
    const cursor = token ? decodeProductInvocationCursor(token) : undefined;
    await this.requireProject(ownerId, projectId);
    const [video, history] = await Promise.all([
      this.db.client.video.findFirst({
        where: { id: sourceVideoId, projectId },
        select: { id: true },
      }),
      this.db.client.productWorkflowInvocation.findFirst({
        where: { projectId, sourceVideoId },
        select: { id: true },
      }),
    ]);
    if (!video && !history) throw new NotFoundException('视频作品或历史来源不存在');
    const rows = await this.db.client.productWorkflowInvocation.findMany({
      where: {
        projectId,
        sourceVideoId,
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
      take: 21,
    });
    const page = rows.slice(0, 20),
      last = page.at(-1);
    return {
      items: page.map((row) => this.dto(row)),
      nextCursor:
        rows.length > 20 && last
          ? encodeProductInvocationCursor({ id: last.id, createdAt: last.createdAt.toISOString() })
          : null,
    };
  }

  async get(ownerId: string, rawProjectId: string, rawId: string) {
    const projectId = z.uuid().parse(rawProjectId),
      id = z.uuid().parse(rawId);
    const invocation = await this.db.client.productWorkflowInvocation.findFirst({
      where: { id, projectId, project: { ownerId } },
    });
    if (!invocation) throw new NotFoundException('产品调用不存在或无权访问');
    return {
      invocation: this.dto(invocation),
      run: await this.runtime.getRun(ownerId, invocation.workflowRunId),
    };
  }

  async lookup(ownerId: string, rawProjectId: string, rawKey: string) {
    const projectId = z.uuid().parse(rawProjectId),
      invocationKey = workflowInvocationKeySchema.parse(rawKey);
    await this.requireProject(ownerId, projectId);
    const invocation = await this.db.client.productWorkflowInvocation.findFirst({
      where: { projectId, invocationKey, project: { ownerId } },
    });
    return { invocation: invocation ? this.dto(invocation) : null };
  }

  private dto(row: Prisma.ProductWorkflowInvocationGetPayload<object>): ProductWorkflowInvocation {
    return productWorkflowInvocationSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
    });
  }
}
