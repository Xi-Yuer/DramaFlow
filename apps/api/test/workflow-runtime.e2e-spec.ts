import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  ImageType,
  NumberType,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  NodeRunRepositories,
  WorkflowCheckpointerService,
  WorkflowNodeRegistryModule,
  WorkflowRunRepositories,
  WorkflowRuntimeFactory,
  WorkflowExecutionService,
  WorkflowRunSubmissionFactory,
  WorkflowVersionRepositories,
} from '@dramaflow/server';
import {
  DefaultDataStoragePolicyResolver,
  DefaultRuntimeValueCodec,
  DefaultWorkflowOutputResolver,
  DefaultWorkflowRunner,
  NodeRegistry,
  type WorkflowRunner,
  type StartWorkflowRunInput,
  type ResumeWorkflowRunInput,
} from '@dramaflow/workflow';
import {
  type INestApplicationContext,
  NotFoundException,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { WorkflowRuntimeService } from '../src/workflow/runtime/workflow-runtime.service.js';
import { WorkflowService } from '../src/workflow/workflows/workflow.service.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test'
)
  throw new Error(
    'Runtime 装配集成测试仅允许在 DramaFlow 的隔离测试数据库运行',
  );

const database = new DatabaseService();
const db = database.client;
const ownerId = randomUUID();
const outsiderId = randomUUID();
const applications: {
  name: string;
  app: INestApplicationContext;
  runtimeToken: Type<unknown>;
}[] = [];

beforeAll(async () => {
  for (const id of [ownerId, outsiderId])
    await db.user.create({
      data: { id, name: 'Runtime 装配测试', email: `${id}@example.test` },
    });
  const constructor = z.custom<Type<unknown>>(
    (value) => typeof value === 'function',
  );
  for (const [name, directory] of [
    ['api', '../dist/'],
    ['worker', '../../worker/dist/'],
  ] as const) {
    // 集成入口先 build；动态加载真实产物保留 Nest metadata，普通 typecheck 不依赖应用 dist。
    const module: unknown = await import(
      new URL(`${directory}app.module.js`, import.meta.url).href
    );
    const runtime: unknown = await import(
      new URL(
        `${directory}workflow/runtime/workflow-runtime.service.js`,
        import.meta.url,
      ).href
    );
    const { AppModule } = z.object({ AppModule: constructor }).parse(module);
    const { WorkflowRuntimeService } = z
      .object({ WorkflowRuntimeService: constructor })
      .parse(runtime);
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    applications.push({
      name,
      app,
      runtimeToken: WorkflowRuntimeService,
    });
  }
});

afterAll(async () => {
  try {
    const runs = await db.workflowRun.findMany({
      where: { project: { ownerId } },
      select: { threadId: true },
    });
    const checkpointer = applications[0]?.app.get(WorkflowCheckpointerService);
    for (const run of runs)
      await checkpointer?.saver.deleteThread(run.threadId);
    await db.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
  } finally {
    await Promise.all(applications.map(({ app }) => app.close()));
    await database.onModuleDestroy();
  }
});

async function fixture(
  definition: WorkflowDefinition = {
    inputs: [],
    nodes: [],
    edges: [],
    outputs: [],
  },
) {
  const project = await db.project.create({
    data: { ownerId, name: 'Runtime 装配', viewport: {} },
  });
  const workflow = await db.workflow.create({
    data: {
      projectId: project.id,
      name: 'Runtime 装配',
      draft: z.record(z.string(), z.json()).parse(definition),
    },
  });
  const version = await new WorkflowService(database).publish(ownerId, {
    workflowId: workflow.id,
    expectedRevision: 1,
  });
  return {
    projectId: project.id,
    workflowId: workflow.id,
    workflowVersionId: version.id,
    inputs: {},
  };
}

// 测试显式组合两个生产边界；生产 Worker 不接受创建参数。
async function start(
  app: INestApplicationContext,
  owner: string,
  input: StartWorkflowRunInput,
) {
  const submission = await app
    .get(WorkflowRunSubmissionFactory)
    .forProject(owner, input.projectId);
  const pending = await submission.start(input);
  expect(pending.status).toBe('pending');
  expect(
    await app
      .get(WorkflowCheckpointerService)
      .saver.getTuple({ configurable: { thread_id: pending.threadId } }),
  ).toBeUndefined();
  return app.get(WorkflowExecutionService).executeStart(pending.id);
}

async function resume(
  app: INestApplicationContext,
  owner: string,
  projectId: string,
  input: ResumeWorkflowRunInput,
) {
  const submission = await app
    .get(WorkflowRunSubmissionFactory)
    .forProject(owner, projectId);
  const job = await submission.resume(input);
  return app.get(WorkflowExecutionService).execute(job);
}

it('API 提交后由独立 Worker 应用执行同一个 pending Run；重复 start Job 不再次执行', async () => {
  const api = applications.find((entry) => entry.name === 'api');
  const worker = applications.find((entry) => entry.name === 'worker');
  if (!api || !worker) throw new Error('应用未启动');
  const submission = api.app.get<WorkflowRuntimeService>(api.runtimeToken);
  const execution = worker.app.get<Pick<WorkflowExecutionService, 'execute'>>(
    worker.runtimeToken,
  );
  const input = await fixture();
  const run = await submission.submitStart(ownerId, input);
  expect(run.status).toBe('pending');
  expect(
    await db.workflowRun.count({ where: { projectId: input.projectId } }),
  ).toBe(1);
  expect(
    await api.app
      .get(WorkflowCheckpointerService)
      .saver.getTuple({ configurable: { thread_id: run.threadId } }),
  ).toBeUndefined();
  const result = await execution.execute({
    kind: 'start',
    workflowRunId: run.id,
  });
  expect(result).toMatchObject({
    workflowRunId: run.id,
    threadId: run.threadId,
    status: 'completed',
  });
  await expect(
    execution.execute({ kind: 'start', workflowRunId: run.id }),
  ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_NOT_PENDING' });
  expect(
    await db.workflowRun.count({ where: { projectId: input.projectId } }),
  ).toBe(1);
});

describe.each(['api', 'worker'])('%s 正式 Nest Runtime 装配', (name) => {
  function context() {
    const application = applications.find((entry) => entry.name === name);
    if (!application) throw new Error('正式应用尚未完成初始化');
    return application;
  }

  it('完整 DI 构造生产 Repository / Codec / Registry / Runner，空图经真实服务与 PostgreSQL 完成', async () => {
    const { app } = context();
    await app.get(DatabaseService).client.$queryRaw`SELECT 1`;
    await app.get(WorkflowCheckpointerService).ping();
    expect(app.get(WorkflowVersionRepositories)).toBeInstanceOf(
      WorkflowVersionRepositories,
    );
    expect(app.get(WorkflowRunRepositories)).toBeInstanceOf(
      WorkflowRunRepositories,
    );
    expect(app.get(NodeRunRepositories)).toBeInstanceOf(NodeRunRepositories);
    expect(app.get(DefaultRuntimeValueCodec)).toBeInstanceOf(
      DefaultRuntimeValueCodec,
    );
    expect(app.get(DefaultDataStoragePolicyResolver)).toBeInstanceOf(
      DefaultDataStoragePolicyResolver,
    );
    expect(app.get(DefaultWorkflowOutputResolver)).toBeInstanceOf(
      DefaultWorkflowOutputResolver,
    );
    const registry = app.get(NodeRegistry);
    expect(registry.listManifests()).toEqual([]);
    expect(
      app
        .select(WorkflowNodeRegistryModule)
        .get(NodeRegistry, { strict: true }),
    ).toBe(registry);

    const input = await fixture();
    const runner: WorkflowRunner = await app
      .get(WorkflowRuntimeFactory)
      .forProject(ownerId, input.projectId);
    expect(runner).toBeInstanceOf(DefaultWorkflowRunner);
    const result = await start(app, ownerId, input);
    expect(result).toMatchObject({ status: 'completed', outputs: {} });
    const run = await db.workflowRun.findUniqueOrThrow({
      where: { id: result.workflowRunId },
    });
    expect(run).toMatchObject({
      ...input,
      threadId: result.threadId,
      status: 'completed',
      outputs: {},
    });
    const checkpoint = await app
      .get(WorkflowCheckpointerService)
      .saver.getTuple({ configurable: { thread_id: run.threadId } });
    expect(checkpoint?.checkpoint.channel_values.run).toMatchObject({
      workflowRunId: run.id,
      workflowVersionId: input.workflowVersionId,
    });
    expect(await db.nodeRun.count({ where: { workflowRunId: run.id } })).toBe(
      0,
    );
    await expect(
      resume(app, ownerId, input.projectId, {
        workflowRunId: run.id,
        value: 1,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_NOT_WAITING' });
    expect(registry.listManifests()).toEqual([]);
  });

  it('无业务节点时明确拒绝未知类型并记录 compile 失败，不注入假节点或产生 NodeRun', async () => {
    const input = await fixture({
      inputs: [],
      nodes: [
        {
          id: 'missing',
          type: 'missing.business_node',
          typeVersion: 1,
          name: '未安装节点',
          inputs: {},
          config: {},
          ui: { position: { x: 0, y: 0 } },
        },
      ],
      edges: [],
      outputs: [],
    });
    await expect(start(context().app, ownerId, input)).rejects.toMatchObject({
      code: 'unavailable_type',
    });
    const run = await db.workflowRun.findFirstOrThrow({
      where: { projectId: input.projectId },
    });
    expect(run).toMatchObject({
      status: 'failed',
      error: { stage: 'compile' },
    });
    expect(await db.nodeRun.count({ where: { workflowRunId: run.id } })).toBe(
      0,
    );
    expect(context().app.get(NodeRegistry).listManifests()).toEqual([]);
  });

  it('引用能力未配置时保留明确错误码，inline 使用真实 Codec，reference 不降级', async () => {
    const codec = context().app.get(DefaultRuntimeValueCodec);
    const valueContext = { projectId: 'project', workflowRunId: 'run' };
    expect(
      await codec.decode(
        { storage: 'inline', type: NumberType, value: 10 },
        valueContext,
      ),
    ).toBe(10);
    expect(
      await codec.encode(12.5, {
        type: NumberType,
        storagePolicy: 'auto',
        context: { ...valueContext, nodeId: 'node', outputKey: 'duration' },
      }),
    ).toEqual({ storage: 'inline', type: NumberType, value: 12.5 });
    await expect(
      codec.decode(
        {
          storage: 'reference',
          type: ImageType,
          reference: { kind: 'asset', id: 'asset', versionId: 'v3' },
        },
        valueContext,
      ),
    ).rejects.toMatchObject({
      code: 'REFERENCE_RESOLUTION_FAILED',
      cause: { code: 'REFERENCE_RUNTIME_NOT_CONFIGURED' },
    });
    for (const storagePolicy of ['reference', 'auto'] as const)
      await expect(
        codec.encode(
          { id: 'image' },
          {
            type: ImageType,
            storagePolicy,
            context: { ...valueContext, nodeId: 'node', outputKey: 'image' },
          },
        ),
      ).rejects.toMatchObject({ code: 'ARTIFACT_WRITER_NOT_CONFIGURED' });
  });

  it('显式所有者 / 项目限定 start 和 resume，不允许跨用户取得 Runner 或修改运行', async () => {
    const input = await fixture();
    const { app } = context();
    await expect(
      app.get(WorkflowRuntimeFactory).forProject(outsiderId, input.projectId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(start(app, outsiderId, input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(
      await db.workflowRun.count({ where: { projectId: input.projectId } }),
    ).toBe(0);
    const result = await start(app, ownerId, input);
    await expect(
      resume(app, outsiderId, input.projectId, {
        workflowRunId: result.workflowRunId,
        value: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      await db.workflowRun.findUniqueOrThrow({
        where: { id: result.workflowRunId },
      }),
    ).toMatchObject({ status: 'completed' });
  });

  it('resume 经生产服务读取原运行；waiting 但缺少 checkpoint 时失败，不重新初始化图', async () => {
    const input = await fixture();
    const { app } = context();
    const repository = await app
      .get(WorkflowRunRepositories)
      .forProject(ownerId, input.projectId);
    const run = await repository.create(input);
    await repository.markRunning(run.id);
    await repository.markWaiting(run.id);
    await expect(
      resume(app, ownerId, input.projectId, {
        workflowRunId: run.id,
        value: 1,
      }),
    ).rejects.toThrow();
    expect(await repository.getById(run.id)).toMatchObject({
      status: 'failed',
      threadId: run.threadId,
      workflowVersionId: input.workflowVersionId,
      error: { stage: 'inspect_state' },
    });
    expect(
      await app
        .get(WorkflowCheckpointerService)
        .saver.getTuple({ configurable: { thread_id: run.threadId } }),
    ).toBeUndefined();
    expect(
      await db.workflowRun.count({ where: { projectId: input.projectId } }),
    ).toBe(1);
  });
});
