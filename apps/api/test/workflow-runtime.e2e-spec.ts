import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ImageType, NumberType, type WorkflowDefinition } from '@dramaflow/contracts';
import {
  DatabaseService,
  ArtifactRuntimeFactory,
  NodeRunRepositories,
  WorkflowCheckpointerService,
  WorkflowExecutionQueue,
  WorkflowExecutionService,
  WorkflowOutboxDispatcher,
  WorkflowRunRepositories,
  WorkflowRunSubmissionFactory,
  WorkflowRuntimeFactory,
  WorkflowVersionRepositories,
} from '@dramaflow/server';
import { NodeRegistry } from '@dramaflow/workflow';
import { type INestApplicationContext, NotFoundException, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { WorkflowRuntimeService } from '../src/workflow/runs/workflow-runtime.service.js';
import { createWorkflowService, storeRuntimeTestVersion } from './fixtures/workflow-service.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !== '/dramaflow_test' ||
  !process.env.WORKFLOW_QUEUE_PREFIX?.startsWith('dramaflow-test-')
)
  throw new Error('Runtime 装配仅允许独立测试库与队列');
const database = new DatabaseService();
const db = database.client;
const ownerId = randomUUID();
const outsiderId = randomUUID();
let api: INestApplicationContext;
let worker: INestApplicationContext;
let apiRuntime: WorkflowRuntimeService;
beforeAll(async () => {
  for (const id of [ownerId, outsiderId])
    await db.user.create({
      data: { id, name: 'Runtime 装配', email: `${id}@example.test` },
    });
  const constructor = z.custom<Type<unknown>>((value) => typeof value === 'function');
  const apiSource: unknown = await import(new URL('../dist/app.module.js', import.meta.url).href);
  api = await NestFactory.createApplicationContext(
    z.object({ AppModule: constructor }).parse(apiSource).AppModule,
    { logger: false, abortOnError: false },
  );
  await api.get(WorkflowExecutionQueue).queue.pause();
  const runtimeSource: unknown = await import(
    new URL('../dist/workflow/runs/workflow-runtime.service.js', import.meta.url).href
  );
  apiRuntime = api.get<WorkflowRuntimeService>(
    z.object({ WorkflowRuntimeService: constructor }).parse(runtimeSource).WorkflowRuntimeService,
  );
  const workerSource: unknown = await import(
    new URL('../../worker/dist/app.module.js', import.meta.url).href
  );
  worker = await NestFactory.createApplicationContext(
    z.object({ AppModule: constructor }).parse(workerSource).AppModule,
    { logger: false, abortOnError: false },
  );
});
afterAll(async () => {
  await worker?.close();
  try {
    const runs = await db.workflowRun.findMany({
      where: { project: { ownerId } },
      select: { threadId: true },
    });
    for (const run of runs)
      await api?.get(WorkflowCheckpointerService).saver.deleteThread(run.threadId);
    await db.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
    await api?.get(WorkflowExecutionQueue).queue.obliterate({ force: true });
  } finally {
    await api?.close();
    await database.onModuleDestroy();
  }
});
async function fixture(unknownNode = false) {
  const project = await db.project.create({
    data: { ownerId, name: '装配', viewport: {} },
  });
  const definition: WorkflowDefinition = {
    inputs: [],
    edges: [],
    outputs: [],
    nodes: unknownNode
      ? [
          {
            id: 'missing',
            type: 'missing.business_node',
            typeVersion: 1,
            name: '未安装节点',
            inputs: {},
            config: {},
            ui: { position: { x: 0, y: 0 } },
          },
        ]
      : [],
  };
  const workflow = await db.workflow.create({
    data: {
      projectId: project.id,
      name: '装配',
      draft: z.record(z.string(), z.json()).parse(definition),
    },
  });
  const version = unknownNode
    ? await storeRuntimeTestVersion(database, workflow, definition)
    : await createWorkflowService(database, new NodeRegistry()).publish(ownerId, {
        workflowId: workflow.id,
        expectedRevision: 1,
      });
  return {
    projectId: project.id,
    workflowId: workflow.id,
    workflowVersionId: version.id,
    invocationKey: randomUUID(),
    inputs: {},
  };
}
async function waitRun(id: string, status: string) {
  await vi.waitFor(
    async () =>
      expect((await db.workflowRun.findUniqueOrThrow({ where: { id } })).status).toBe(status),
    { timeout: 10000 },
  );
}
describe('正式 Nest 应用的提交 / 队列 / 执行装配', () => {
  it('API 只有提交 / Dispatcher，Worker 构造真实执行依赖，Registry 提供正式文本 AI 节点', async () => {
    for (const app of [api, worker]) {
      await app.get(WorkflowCheckpointerService).ping();
      expect(app.get(WorkflowRunRepositories)).toBeInstanceOf(WorkflowRunRepositories);
      expect(app.get(WorkflowVersionRepositories)).toBeInstanceOf(WorkflowVersionRepositories);
      expect(app.get(NodeRegistry).listManifests()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'ai.text_generate',
            version: 1,
            executionKind: 'action',
          }),
          expect.objectContaining({
            type: 'data.format_text',
            version: 1,
            executionKind: 'action',
          }),
        ]),
      );
    }
    expect(api.get(WorkflowRunSubmissionFactory)).toBeInstanceOf(WorkflowRunSubmissionFactory);
    expect(api.get(WorkflowOutboxDispatcher)).toBeInstanceOf(WorkflowOutboxDispatcher);
    expect(() => api.get(WorkflowExecutionService)).toThrow();
    expect(() => api.get(WorkflowRuntimeFactory)).toThrow();
    expect(worker.get(WorkflowExecutionService)).toBeInstanceOf(WorkflowExecutionService);
    expect(worker.get(NodeRunRepositories)).toBeInstanceOf(NodeRunRepositories);
  });
  it('API 提交与 Worker 消费同一 Run，不创建第二条记录；旧 Job 重投只返回 already_processed', async () => {
    const input = await fixture();
    const run = await apiRuntime.submitStart(ownerId, input);
    expect(run.status).toBe('pending');
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRunId: run.id },
      }),
    ).toBe(1);
    expect(
      await api
        .get(WorkflowCheckpointerService)
        .saver.getTuple({ configurable: { thread_id: run.threadId } }),
    ).toBeUndefined();
    await api.get(WorkflowOutboxDispatcher).publishStart(run.id);
    await api.get(WorkflowExecutionQueue).queue.resume();
    try {
      await waitRun(run.id, 'completed');
      await vi.waitFor(async () =>
        expect(
          (
            await db.workflowExecutionOutbox.findFirstOrThrow({
              where: { workflowRunId: run.id },
            })
          ).status,
        ).toBe('completed'),
      );
      expect(await worker.get(WorkflowExecutionService).executeStart(run.id)).toMatchObject({
        status: 'already_processed',
      });
      expect(await db.workflowRun.count({ where: { projectId: input.projectId } })).toBe(1);
      expect(await db.nodeRun.count({ where: { workflowRunId: run.id } })).toBe(0);
    } finally {
      await api.get(WorkflowExecutionQueue).queue.pause();
    }
  });
  it('提交按所有者限定权限，不能跨用户创建 Run 或恢复意图', async () => {
    const input = await fixture();
    await expect(apiRuntime.submitStart(outsiderId, input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await db.workflowRun.count({ where: { projectId: input.projectId } })).toBe(0);
    await expect(
      apiRuntime.submitResume(outsiderId, input.projectId, {
        workflowRunId: 'missing',
        value: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it('未知节点由 Worker 记 compile 失败，Queue 不自动重跑或产生假 NodeRun', async () => {
    const input = await fixture(true);
    const run = await apiRuntime.submitStart(ownerId, input);
    await api.get(WorkflowOutboxDispatcher).publishStart(run.id);
    await api.get(WorkflowExecutionQueue).queue.resume();
    try {
      await waitRun(run.id, 'failed');
      expect(await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        error: { stage: 'compile' },
      });
      await vi.waitFor(async () =>
        expect(
          (
            await db.workflowExecutionOutbox.findFirstOrThrow({
              where: { workflowRunId: run.id },
            })
          ).status,
        ).toBe('failed'),
      );
      expect(await db.nodeRun.count({ where: { workflowRunId: run.id } })).toBe(0);
    } finally {
      await api.get(WorkflowExecutionQueue).queue.pause();
    }
  });
  it('Artifact Codec 按已授权运行构造，Asset 仍明确拒绝，inline 不产生内容 I/O', async () => {
    const input = await fixture();
    const run = await apiRuntime.submitStart(ownerId, input);
    const codec = await worker.get(ArtifactRuntimeFactory).forRun(ownerId, input.projectId, run.id);
    const context = { projectId: input.projectId, workflowRunId: run.id };
    expect(await codec.decode({ storage: 'inline', type: NumberType, value: 10 }, context)).toBe(
      10,
    );
    await expect(
      codec.decode(
        {
          storage: 'reference',
          type: ImageType,
          reference: { kind: 'asset', id: 'asset', versionId: 'v3' },
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: 'REFERENCE_RESOLUTION_FAILED',
      cause: { code: 'ASSET_REFERENCE_NOT_CONFIGURED' },
    });
    await expect(
      codec.encode(
        { id: 'image' },
        {
          type: ImageType,
          storagePolicy: 'auto',
          context: { ...context, nodeId: 'node', outputKey: 'image' },
        },
      ),
    ).rejects.toMatchObject({
      code: 'ARTIFACT_WRITE_FAILED',
      stage: 'prepare',
    });
    expect(await db.artifact.count({ where: { workflowRunId: run.id } })).toBe(0);
  });
  it('waiting 缺少 checkpoint 时恢复同一记录失败，不初始化新线程', async () => {
    const input = await fixture();
    const run = await apiRuntime.submitStart(ownerId, input);
    const repository = await api.get(WorkflowRunRepositories).forProject(ownerId, input.projectId);
    await repository.markRunning(run.id);
    await repository.markWaiting(run.id);
    const job = await apiRuntime.submitResume(ownerId, input.projectId, {
      workflowRunId: run.id,
      value: 1,
    });
    await api.get(WorkflowOutboxDispatcher).publishExecution(job.executionId);
    await api.get(WorkflowExecutionQueue).queue.resume();
    try {
      await waitRun(run.id, 'failed');
      expect(await repository.getById(run.id)).toMatchObject({
        threadId: run.threadId,
        error: { stage: 'inspect_state' },
      });
      expect(
        await api
          .get(WorkflowCheckpointerService)
          .saver.getTuple({ configurable: { thread_id: run.threadId } }),
      ).toBeUndefined();
    } finally {
      await api.get(WorkflowExecutionQueue).queue.pause();
    }
  });
});
