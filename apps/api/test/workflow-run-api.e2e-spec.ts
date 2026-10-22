import 'reflect-metadata';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  NumberType,
  workflowRunResponseSchema,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  WorkflowCheckpointerService,
  WorkflowExecutionQueue,
  WorkflowExecutionService,
  WorkflowRuntimeFactory,
  WorkflowOutboxDispatcher,
  workflowExecutionJobId,
} from '@dramaflow/server';
import { DefaultWorkflowRunner, NodeRegistry } from '@dramaflow/workflow';
import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthService } from '../src/auth/auth.service.js';
import { mountAuth } from '../src/auth/auth.http.js';
import { authBaseUrl } from '../src/auth/trusted-origin.js';
import { ApiExceptionFilter } from '../src/http/exception.filter.js';
import {
  createWorkflowService,
  storeRuntimeTestVersion,
} from './fixtures/workflow-service.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test' ||
  !process.env.WORKFLOW_QUEUE_PREFIX?.startsWith('dramaflow-test-')
)
  throw new Error('Run HTTP 仅允许独立测试库与队列');
const database = new DatabaseService();
const db = database.client;
const applications: Awaited<ReturnType<typeof application>>[] = [];
const userIds: string[] = [];
let ownerId: string;
let cookieA: string;
let cookieB: string;
let worker: ChildProcess | undefined;
const origin = new URL(authBaseUrl()).origin;
const executeStart = vi.spyOn(DefaultWorkflowRunner.prototype, 'executeStart');
const executeResume = vi.spyOn(
  DefaultWorkflowRunner.prototype,
  'executeResume',
);

async function application() {
  const constructor = z.custom<Type<unknown>>(
    (value) => typeof value === 'function',
  );
  const module: unknown = await import(
    new URL('../dist/app.module.js', import.meta.url).href
  );
  const authModule: unknown = await import(
    new URL('../dist/auth/auth.service.js', import.meta.url).href
  );
  const { AppModule } = z.object({ AppModule: constructor }).parse(module);
  const { AuthService: AuthToken } = z
    .object({ AuthService: constructor })
    .parse(authModule);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: false,
    abortOnError: false,
  });
  const auth = app.get<AuthService>(AuthToken);
  mountAuth(app.getHttpAdapter().getInstance(), auth);
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  return { app, auth, base: await app.getUrl() };
}
async function startWorker() {
  const child = fork(
    fileURLToPath(
      new URL('./fixtures/queue-worker-process.ts', import.meta.url),
    ),
    [],
    {
      execArgv: ['--import', import.meta.resolve('tsx')],
      env: process.env,
      silent: true,
    },
  );
  worker = child;
  let ready = false;
  let stderr = '';
  child.on('message', (value) => {
    if (z.object({ event: z.string() }).parse(value).event === 'ready')
      ready = true;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.send({ mode: 'worker' });
  await vi.waitFor(
    () => {
      if (child.exitCode !== null) throw new Error(stderr);
      expect(ready).toBe(true);
    },
    { timeout: 15000 },
  );
}
beforeAll(async () => {
  applications.push(await application(), await application());
  await applications[0]!.app.get(WorkflowExecutionQueue).queue.pause();
  const password = randomBytes(24).toString('hex');
  for (const name of ['A', 'B']) {
    const email = `run-api-${randomUUID()}@example.test`;
    const auth = applications[0]!.auth.auth;
    const { user } = await auth.api.createUser({
      body: { email, name: `Run API ${name}`, password, role: 'user' },
    });
    userIds.push(user.id);
    const response = await auth.api.signInEmail({
      body: { email, password, rememberMe: true },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(cookie).not.toBe('');
    if (name === 'A') {
      ownerId = user.id;
      cookieA = cookie;
    } else cookieB = cookie;
  }
});
afterAll(async () => {
  try {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        worker!.once('exit', () => resolve()),
      );
      worker.send({ event: 'close' });
      await exited;
    }
    const records = await db.workflowRun.findMany({
      where: { project: { ownerId: { in: userIds } } },
      select: { threadId: true },
    });
    for (const run of records)
      await applications[0]?.app
        .get(WorkflowCheckpointerService)
        .saver.deleteThread(run.threadId);
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await applications[0]?.app
      .get(WorkflowExecutionQueue)
      .queue.obliterate({ force: true });
  } finally {
    vi.restoreAllMocks();
    await Promise.all(applications.map(({ app }) => app.close()));
    await database.onModuleDestroy();
  }
});
function api(
  index: number,
  path: string,
  method = 'GET',
  body?: unknown,
  cookie: string | null = cookieA,
  requestOrigin = origin,
) {
  const application = applications[index];
  if (!application) throw new Error('测试 API 未就绪');
  return fetch(`${application.base}/api/v1/workflow-runs${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined
        ? { 'Content-Type': 'application/json', Origin: requestOrigin }
        : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function result(response: Response, status = 200) {
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body: unknown = await response.json();
  expect(body).not.toHaveProperty('threadId');
  expect(body).not.toHaveProperty('projectId');
  return workflowRunResponseSchema.parse(body);
}
async function failure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body: unknown = await response.json();
  const error = z
    .object({
      code: z.string(),
      message: z.string(),
      requestId: z.uuid(),
      details: z.unknown().optional(),
    })
    .strict()
    .parse(body);
  expect(error.code).toBe(code);
  expect(body).not.toHaveProperty('stack');
  expect(body).not.toHaveProperty('cause');
  return error;
}
async function version(
  native = false,
  inputs: WorkflowDefinition['inputs'] = [],
) {
  const project = await db.project.create({
    data: { ownerId, name: 'Run HTTP', viewport: {} },
  });
  const definition: WorkflowDefinition = {
    inputs,
    nodes: native
      ? ['first', 'second'].map((id) => ({
          id,
          type: 'test.queue_wait',
          typeVersion: 1,
          name: '原生测试等待',
          inputs: {},
          config: {},
          ui: { position: { x: 0, y: 0 } },
        }))
      : [],
    edges: [],
    outputs: native
      ? [
          {
            name: 'first',
            type: NumberType,
            source: { nodeId: 'first', outputKey: 'value' },
          },
          {
            name: 'second',
            type: NumberType,
            source: { nodeId: 'second', outputKey: 'value' },
          },
        ]
      : [],
  };
  const workflow = await db.workflow.create({
    data: {
      projectId: project.id,
      name: 'HTTP Queue',
      draft: z.record(z.string(), z.json()).parse(definition),
    },
  });
  const published = native
    ? await storeRuntimeTestVersion(database, workflow, definition)
    : await createWorkflowService(database, new NodeRegistry()).publish(
        ownerId,
        {
          workflowId: workflow.id,
          expectedRevision: 1,
        },
      );
  return { projectId: project.id, workflowVersionId: published.id };
}
async function waitRun(id: string, status: string, waitingRevision?: number) {
  await vi.waitFor(
    async () => {
      const row = await db.workflowRun.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe(status);
      if (waitingRevision !== undefined)
        expect(row.waitingRevision).toBe(waitingRevision);
    },
    { timeout: 15000 },
  );
}
async function waiting() {
  const identity = await version(true);
  const run = await result(
    await api(0, '', 'POST', {
      workflowVersionId: identity.workflowVersionId,
      inputs: {},
    }),
    202,
  );
  await waitRun(run.id, 'waiting', 1);
  return { ...identity, run };
}

describe('真实异步 Workflow Run HTTP → Outbox → Redis → 独立 Worker', () => {
  it.each([
    ['WORKFLOW_INVOCATION_INPUT_REQUIRED', {}],
    [
      'WORKFLOW_INVOCATION_INPUT_UNKNOWN',
      {
        count: { storage: 'inline', type: NumberType, value: 0 },
        extra: { storage: 'inline', type: NumberType, value: 1 },
      },
    ],
    [
      'WORKFLOW_INVOCATION_INPUT_TYPE_MISMATCH',
      {
        count: {
          storage: 'inline',
          type: { kind: 'primitive', name: 'string' },
          value: '0',
        },
      },
    ],
    [
      'WORKFLOW_INVOCATION_INPUT_VALUE_INVALID',
      {
        count: {
          storage: 'inline',
          type: NumberType,
          value: 'private-invalid-value',
        },
      },
    ],
  ])(
    '调用契约 %s 在受理前拒绝，数据库中无 Run / Outbox',
    async (code, inputs) => {
      const f = await version(false, [
        { name: 'count', type: NumberType, required: true },
      ]);
      const error = await failure(
        await api(0, '', 'POST', {
          workflowVersionId: f.workflowVersionId,
          inputs,
        }),
        400,
        code,
      );
      expect(JSON.stringify(error)).not.toContain('private-invalid-value');
      expect(
        await db.workflowRun.count({ where: { projectId: f.projectId } }),
      ).toBe(0);
      expect(
        await db.workflowExecutionOutbox.count({
          where: { workflowRun: { projectId: f.projectId } },
        }),
      ).toBe(0);
    },
  );

  it('三个入口默认鉴权，写请求校验 Origin；API DI 不含 Runner factory 或 ExecutionService', async () => {
    for (const [path, method, body] of [
      ['', 'POST', { workflowVersionId: 'missing', inputs: {} }],
      ['/missing', 'GET', undefined],
      ['/missing/resume', 'POST', { value: 1 }],
    ] as const)
      await failure(await api(0, path, method, body, null), 401, 'HTTP_401');
    await failure(
      await api(
        0,
        '',
        'POST',
        { workflowVersionId: 'missing', inputs: {} },
        cookieA,
        'https://untrusted.invalid',
      ),
      403,
      'HTTP_403',
    );
    for (const { app } of applications) {
      expect(() => app.get(WorkflowRuntimeFactory)).toThrow();
      expect(() => app.get(WorkflowExecutionService)).toThrow();
    }
  });

  it('没有 Worker 时 POST 仍立即返回 202 + pending；新 Worker 进程完成原 Run，API 从不 invoke', async () => {
    const identity = await version();
    const run = await result(
      await api(0, '', 'POST', {
        workflowVersionId: identity.workflowVersionId,
        inputs: {},
      }),
      202,
    );
    expect(run.status).toBe('pending');
    const saved = await db.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(saved.startedAt).toBeNull();
    const queue = applications[0]!.app.get(WorkflowExecutionQueue);
    const job = await queue.queue.getJob(
      workflowExecutionJobId({ kind: 'start', workflowRunId: run.id }),
    );
    expect(job?.data).toEqual({ kind: 'start', workflowRunId: run.id });
    expect(
      await applications[0]!.app
        .get(WorkflowCheckpointerService)
        .saver.getTuple({ configurable: { thread_id: saved.threadId } }),
    ).toBeUndefined();
    await startWorker();
    await queue.queue.resume();
    await waitRun(run.id, 'completed');
    expect(await result(await api(1, `/${run.id}`))).toMatchObject({
      id: run.id,
      status: 'completed',
      outputs: {},
    });
    expect(executeStart).not.toHaveBeenCalled();
    expect(executeResume).not.toHaveBeenCalled();
  });

  it('跨用户的 Version / Run 统一 404，不能读取或提交恢复意图', async () => {
    const f = await waiting();
    const before = await db.workflowExecutionOutbox.count({
      where: { workflowRunId: f.run.id },
    });
    await failure(
      await api(
        0,
        '',
        'POST',
        { workflowVersionId: f.workflowVersionId, inputs: {} },
        cookieB,
      ),
      404,
      'WORKFLOW_VERSION_NOT_FOUND',
    );
    await failure(
      await api(1, `/${f.run.id}`, 'GET', undefined, cookieB),
      404,
      'WORKFLOW_RUN_NOT_FOUND',
    );
    await failure(
      await api(1, `/${f.run.id}/resume`, 'POST', { value: 1 }, cookieB),
      404,
      'WORKFLOW_RUN_NOT_FOUND',
    );
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRunId: f.run.id },
      }),
    ).toBe(before);
    expect(
      (await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } }))
        .status,
    ).toBe('waiting');
  });

  it('两个等待周期通过两个独立 Outbox 意图恢复原版本 / thread；0 值保留', async () => {
    const f = await waiting();
    const original = await db.workflowRun.findUniqueOrThrow({
      where: { id: f.run.id },
    });
    await result(
      await api(1, `/${f.run.id}/resume`, 'POST', { value: 0 }),
      202,
    );
    await waitRun(f.run.id, 'waiting', 2);
    await result(
      await api(0, `/${f.run.id}/resume`, 'POST', { value: 20 }),
      202,
    );
    await waitRun(f.run.id, 'completed');
    expect(await result(await api(1, `/${f.run.id}`))).toMatchObject({
      status: 'completed',
      outputs: { first: { value: 0 }, second: { value: 20 } },
    });
    expect(
      await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } }),
    ).toMatchObject({
      threadId: original.threadId,
      workflowVersionId: original.workflowVersionId,
      startedAt: original.startedAt,
    });
    const intents = await db.workflowExecutionOutbox.findMany({
      where: { workflowRunId: f.run.id, kind: 'resume' },
    });
    expect(new Set(intents.map((intent) => intent.id)).size).toBe(2);
    expect(executeStart).not.toHaveBeenCalled();
    expect(executeResume).not.toHaveBeenCalled();
  });

  it('两个 API 同时提交同一 waiting 周期，只有一个恢复意图，另一个 409', async () => {
    const f = await waiting();
    const queue = applications[0]!.app.get(WorkflowExecutionQueue);
    await queue.queue.pause();
    try {
      const responses = await Promise.all([
        api(0, `/${f.run.id}/resume`, 'POST', { value: 5 }),
        api(1, `/${f.run.id}/resume`, 'POST', { value: 7 }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        202, 409,
      ]);
      for (const response of responses)
        if (response.status === 202) await result(response, 202);
        else await failure(response, 409, 'WORKFLOW_RESUME_ALREADY_SUBMITTED');
      expect(
        await db.workflowExecutionOutbox.count({
          where: { workflowRunId: f.run.id, kind: 'resume' },
        }),
      ).toBe(1);
      expect(
        (await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } }))
          .status,
      ).toBe('waiting');
    } finally {
      await queue.queue.resume();
    }
    await waitRun(f.run.id, 'waiting', 2);
  });

  it('严格校验 start / resume 字段，不能指定 thread、身份、版本副本或省略 value', async () => {
    const f = await version();
    for (const key of [
      'threadId',
      'projectId',
      'workflowId',
      'status',
      'definition',
    ])
      await failure(
        await api(0, '', 'POST', {
          workflowVersionId: f.workflowVersionId,
          inputs: {},
          [key]: 'injected',
        }),
        400,
        'VALIDATION_FAILED',
      );
    const waitingRun = await waiting();
    await failure(
      await api(0, `/${waitingRun.run.id}/resume`, 'POST', {}),
      400,
      'VALIDATION_FAILED',
    );
    await failure(
      await api(0, `/${waitingRun.run.id}/resume`, 'POST', {
        value: 0,
        executionId: 'injected',
      }),
      400,
      'VALIDATION_FAILED',
    );
    expect(
      await db.workflowRun.count({ where: { projectId: f.projectId } }),
    ).toBe(0);
  });

  it('Redis enqueue 未确认时不返回 202；安全 503，Outbox 仍存在且后台能继续投递', async () => {
    const identity = await version();
    const queue = applications[0]!.app.get(WorkflowExecutionQueue);
    await queue.queue.pause();
    const publish = vi
      .spyOn(queue, 'publish')
      .mockRejectedValue(new Error('redis-secret-marker'));
    try {
      const error = await failure(
        await api(0, '', 'POST', {
          workflowVersionId: identity.workflowVersionId,
          inputs: {},
        }),
        503,
        'WORKFLOW_QUEUE_UNAVAILABLE',
      );
      expect(JSON.stringify(error)).not.toContain('secret-marker');
      const run = await db.workflowRun.findFirstOrThrow({
        where: { projectId: identity.projectId },
      });
      expect(run.status).toBe('pending');
      expect(
        await db.workflowExecutionOutbox.count({
          where: { workflowRunId: run.id },
        }),
      ).toBe(1);
      publish.mockRestore();
      await applications[0]!.app
        .get(WorkflowOutboxDispatcher)
        .publishStart(run.id);
      await queue.queue.resume();
      await waitRun(run.id, 'completed');
    } finally {
      publish.mockRestore();
      await queue.queue.resume();
    }
  });
});
