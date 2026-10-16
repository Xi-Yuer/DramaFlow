import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  humanResponseSchema,
  jsonObjectSchema,
  regenerateSchema,
  startRunSchema,
  workflowDefinitionSchema,
  type WorkflowRun,
} from '@dramaflow/contracts';
import { getInvalidatedNodeIds } from '@dramaflow/workflow';
import { DatabaseService } from '../infrastructure/database.service.js';
import { RunQueue } from '../infrastructure/queue.service.js';
import { AccessService } from '../auth/access.service.js';
import { json, parse } from '../infrastructure/validation.js';
import { mapEvent, mapRun, mapTask } from './run-mapper.js';

@Injectable()
export class RunsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly queue: RunQueue,
  ) {}
  async list(userId: string, workflowId: string) {
    await this.access.workflow(userId, workflowId);
    const rows = await this.db.client.run.findMany({
      where: { workflowId },
      include: { attempts: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { items: rows.map(mapRun) };
  }
  async get(userId: string, runId: string): Promise<WorkflowRun> {
    await this.access.run(userId, runId);
    return mapRun(
      await this.db.client.run.findUniqueOrThrow({
        where: { id: runId },
        include: { attempts: true },
      }),
    );
  }
  async start(
    userId: string,
    workflowId: string,
    body: unknown,
  ): Promise<WorkflowRun> {
    const workflow = await this.access.workflow(userId, workflowId, 'editor');
    const input = parse(startRunSchema, body);
    const existing = await this.db.client.run.findUnique({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId: workflow.workspaceId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (
        existing.workflowId !== workflowId ||
        !isDeepStrictEqual(existing.inputs, input.input) ||
        (input.versionId && existing.versionId !== input.versionId)
      )
        throw new ConflictException('幂等键已用于不同的运行请求');
      await this.queue.wake(existing.id, 'start');
      return this.get(userId, existing.id);
    }
    const version = await this.db.client.workflowVersion.findFirst({
      where: {
        workflowId,
        ...(input.versionId ? { id: input.versionId } : {}),
      },
      orderBy: { number: 'desc' },
    });
    if (!version) throw new BadRequestException('请先发布有效的工作流版本');
    const run = await this.db.client.$transaction(async (tx) => {
      const row = await tx.run.create({
        data: {
          workspaceId: workflow.workspaceId,
          workflowId,
          versionId: version.id,
          requestedBy: userId,
          inputs: json(input.input),
          idempotencyKey: input.idempotencyKey,
        },
      });
      await tx.runEvent.create({
        data: { runId: row.id, type: 'run.queued', data: {} },
      });
      return row;
    });
    await this.queue.wake(run.id, 'start');
    return this.get(userId, run.id);
  }
  async events(userId: string, runId: string, after?: string) {
    await this.access.run(userId, runId);
    if (after && !/^\d+$/.test(after))
      throw new BadRequestException('事件游标无效');
    const rows = await this.db.client.runEvent.findMany({
      where: { runId, ...(after ? { id: { gt: BigInt(after) } } : {}) },
      orderBy: { id: 'asc' },
      take: 500,
    });
    return { items: rows.map(mapEvent) };
  }
  async tasks(userId: string, runId: string) {
    await this.access.run(userId, runId);
    return {
      items: (
        await this.db.client.humanTask.findMany({
          where: { runId },
          include: { run: true },
          orderBy: { createdAt: 'asc' },
        })
      ).map(mapTask),
    };
  }
  async respond(userId: string, taskId: string, body: unknown) {
    const input = parse(humanResponseSchema, body);
    const task = await this.db.client.humanTask.findUnique({
      where: { id: taskId },
    });
    if (!task) throw new NotFoundException('人工任务不存在');
    const run = await this.access.run(userId, task.runId, 'editor');
    if (task.respondedAt) {
      if (
        task.responseKey !== input.idempotencyKey ||
        !isDeepStrictEqual(task.response, input)
      )
        throw new ConflictException('人工任务已经处理');
      return mapTask(await this.db.client.humanTask.findUniqueOrThrow({ where: { id: taskId }, include: { run: true } }));
    } else {
      if (['succeeded', 'failed', 'canceled'].includes(run.status)) throw new ConflictException('该运行已结束');
      const changed = await this.db.client.humanTask.updateMany({
        where: { id: taskId, respondedAt: null },
        data: {
          response: json(input),
          respondedAt: new Date(),
          respondedBy: userId,
          responseKey: input.idempotencyKey,
        },
      });
      if (changed.count !== 1)
        throw new ConflictException('人工任务已被其他成员处理');
    }
    await this.queue.wake(task.runId, `task-${taskId}`);
    return mapTask(
      await this.db.client.humanTask.findUniqueOrThrow({
        where: { id: taskId },
        include: { run: true },
      }),
    );
  }
  async cancel(userId: string, runId: string) {
    const run = await this.access.run(userId, runId, 'editor');
    if (['succeeded', 'failed', 'canceled'].includes(run.status))
      return this.get(userId, runId);
    await this.db.client.run.update({
      where: { id: runId },
      data: { cancelRequestedAt: new Date() },
    });
    await this.queue.wake(runId, `cancel-${randomUUID()}`);
    return this.get(userId, runId);
  }
  async regenerate(userId: string, runId: string, body: unknown) {
    const original = await this.access.run(userId, runId, 'editor');
    if (original.status === 'running' || original.status === 'queued')
      throw new ConflictException('请等待或取消当前运行后重新生成');
    const input = parse(regenerateSchema, body);
    const version = await this.db.client.workflowVersion.findUniqueOrThrow({
      where: { id: original.versionId },
    });
    const definition = parse(workflowDefinitionSchema, version.definition);
    const node = definition.nodes.find((node) => node.id === input.nodeId);
    if (!node || !['text', 'image', 'video', 'batch'].includes(node.type))
      throw new BadRequestException('该节点不支持重新生成');
    const existing = await this.db.client.run.findUnique({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId: original.workspaceId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (
        existing.parentRunId !== runId ||
        existing.regenerateNodeId !== input.nodeId ||
        existing.continueDownstream !== input.continueDownstream ||
        !isDeepStrictEqual(
          existing.configOverrides,
          input.configOverrides ?? {},
        )
      )
        throw new ConflictException('幂等键已用于不同请求');
      await this.queue.wake(existing.id, 'start');
      return this.get(userId, existing.id);
    }
    const invalidatedNodeIds = getInvalidatedNodeIds(definition, input.nodeId);
    const child = await this.db.client.$transaction(async (tx) => {
      const row = await tx.run.create({
        data: {
          workspaceId: original.workspaceId,
          workflowId: original.workflowId,
          versionId: original.versionId,
          requestedBy: userId,
          inputs: json(parse(jsonObjectSchema, original.inputs)),
          idempotencyKey: input.idempotencyKey,
          parentRunId: runId,
          regenerateNodeId: input.nodeId,
          continueDownstream: input.continueDownstream,
          invalidatedNodeIds: json(invalidatedNodeIds),
          configOverrides: json(input.configOverrides ?? {}),
        },
      });
      await tx.runEvent.create({
        data: {
          runId: row.id,
          type: 'run.queued',
          data: { parentRunId: runId, invalidatedNodeIds },
        },
      });
      return row;
    });
    await this.queue.wake(child.id, 'start');
    return this.get(userId, child.id);
  }
}
