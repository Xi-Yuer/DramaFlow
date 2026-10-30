import 'reflect-metadata';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  cancelWorkflowRunResponseSchema,
  StringType,
  NumberType,
  pendingHumanReviewsResponseSchema,
  type PendingHumanReview,
  AnyType,
  workflowRunResponseSchema,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  WorkflowCheckpointerService,
  WorkflowExecutionQueue,
  WorkflowExecutionService,
  WorkflowRuntimeFactory,
  WorkflowRunRepositories,
  workflowExecutionJobId,
} from '@dramaflow/server';
import {
  DefaultWorkflowRunner,
  NodeRegistry,
  createHumanReviewNodeType,
} from '@dramaflow/workflow';
import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { INTERRUPT } from '@langchain/langgraph';
import type { AuthService } from '../src/auth/auth.service.js';
import { mountAuth } from '../src/auth/auth.http.js';
import { authBaseUrl } from '../src/auth/trusted-origin.js';
import { ApiExceptionFilter } from '../src/http/exception.filter.js';
import { createWorkflowService } from './fixtures/workflow-service.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !== '/dramaflow_test' ||
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
const executeResume = vi.spyOn(DefaultWorkflowRunner.prototype, 'executeResume');

async function application() {
  const constructor = z.custom<Type<unknown>>((value) => typeof value === 'function');
  const module: unknown = await import(new URL('../dist/app.module.js', import.meta.url).href);
  const authModule: unknown = await import(
    new URL('../dist/auth/auth.service.js', import.meta.url).href
  );
  const { AppModule } = z.object({ AppModule: constructor }).parse(module);
  const { AuthService: AuthToken } = z.object({ AuthService: constructor }).parse(authModule);
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
    fileURLToPath(new URL('./fixtures/queue-worker-process.ts', import.meta.url)),
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
    if (z.object({ event: z.string() }).parse(value).event === 'ready') ready = true;
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
      const exited = new Promise<void>((resolve) => worker!.once('exit', () => resolve()));
      worker.send({ event: 'close' });
      await exited;
    }
    const records = await db.workflowRun.findMany({
      where: { project: { ownerId: { in: userIds } } },
      select: { threadId: true },
    });
    for (const run of records)
      await applications[0]?.app.get(WorkflowCheckpointerService).saver.deleteThread(run.threadId);
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await applications[0]?.app.get(WorkflowExecutionQueue).queue.obliterate({ force: true });
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
      ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: requestOrigin } : {}),
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
      workflowRunId: z.string().optional(),
      invocationKey: z.string().optional(),
    })
    .strict()
    .parse(body);
  expect(error.code).toBe(code);
  expect(body).not.toHaveProperty('stack');
  expect(body).not.toHaveProperty('cause');
  return error;
}
async function version(native = false, inputs: WorkflowDefinition['inputs'] = []) {
  const project = await db.project.create({
    data: { ownerId, name: 'Run HTTP' },
  });
  const definition: WorkflowDefinition = {
    inputs,
    nodes: native
      ? ['first', 'second'].map((id) => ({
          id,
          type: 'flow.human_review',
          typeVersion: 1,
          name: id === 'first' ? '人物设定审核' : '第二轮审核',
          inputs: { content: { type: 'constant', value: `${id} 审核文本` } },
          config: { instruction: '请核对内容' },
          ui: { position: { x: 0, y: 0 } },
        }))
      : [],
    edges: native
      ? [
          {
            id: 'review-order',
            kind: 'control',
            source: { nodeId: 'first' },
            target: { nodeId: 'second' },
          },
        ]
      : [],
    outputs: native
      ? [
          {
            name: 'first',
            type: StringType,
            source: { nodeId: 'first', outputKey: 'action' },
          },
          {
            name: 'second',
            type: StringType,
            source: { nodeId: 'second', outputKey: 'action' },
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
  const published = await createWorkflowService(
    database,
    new NodeRegistry(native ? [createHumanReviewNodeType()] : []),
  ).publish(ownerId, { workflowId: workflow.id, expectedRevision: 1 });
  return { projectId: project.id, workflowVersionId: published.id };
}
async function waitRun(id: string, status: string, waitingRevision?: number) {
  await vi.waitFor(
    async () => {
      const row = await db.workflowRun.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe(status);
      if (waitingRevision !== undefined) expect(row.waitingRevision).toBe(waitingRevision);
    },
    { timeout: 15000 },
  );
}
async function pending(id: string, index = 0) {
  const response = await api(index, `/${id}/pending-human-reviews`);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body: unknown = await response.json();
  const parsed = pendingHumanReviewsResponseSchema.parse(body);
  expect(JSON.stringify(body)).not.toMatch(
    /threadId|checkpoint|namespace|nodeRunId|tasks|RuntimeValue/,
  );
  return parsed;
}
function reviewBody(
  review: PendingHumanReview,
  value: { action: 'approve' | 'reject'; feedback?: string } = {
    action: 'approve',
  },
) {
  return {
    interruptId: review.interruptId,
    expectedWaitingRevision: review.waitingRevision,
    value,
  };
}
async function waiting() {
  const identity = await version(true);
  const run = await result(
    await api(0, '', 'POST', {
      workflowVersionId: identity.workflowVersionId,
      invocationKey: randomUUID(),
      inputs: {},
    }),
    202,
  );
  await waitRun(run.id, 'waiting', 1);
  const review = (await pending(run.id)).items[0]!;
  return { ...identity, run, review };
}

describe('真实异步 Workflow Run HTTP → Outbox → Redis → 独立 Worker', () => {
  it.each(['pending', 'running'] as const)(
    'Cancel 产品 HTTP：%s 使用真实授权、事务与查询投影',
    async (status) => {
      const identity = await version();
      const run = await result(
        await api(0, '', 'POST', {
          workflowVersionId: identity.workflowVersionId,
          invocationKey: randomUUID(),
          inputs: {},
        }),
        202,
      );
      if (status === 'running') {
        const intent = await db.workflowExecutionOutbox.findFirstOrThrow({
          where: { workflowRunId: run.id },
        });
        const repository = await applications[0]!.app
          .get(WorkflowRunRepositories)
          .forProject(ownerId, identity.projectId, intent.id);
        expect(await repository.claimPendingForStart(run.id)).not.toBeNull();
      }
      const url = `${applications[0]!.base}/api/v1/projects/${identity.projectId}/workflows/${run.workflowId}/runs/${run.id}/cancel`;
      const post = (cookie = cookieA) =>
        fetch(url, {
          method: 'POST',
          headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
          body: '{}',
        });
      expect((await post(cookieB)).status).toBe(404);
      const first = await post();
      expect(first.status).toBe(200);
      expect(first.headers.get('Cache-Control')).toBe('no-store');
      const response = cancelWorkflowRunResponseSchema.parse(await first.json());
      expect(response).toMatchObject({
        outcome: status === 'pending' ? 'cancelled' : 'requested',
        run: {
          status: status === 'pending' ? 'cancelled' : 'running',
          cancellation: status === 'pending' ? 'none' : 'requested',
        },
      });
      expect(JSON.stringify(response)).not.toMatch(
        /threadId|executionId|checkpoint|Outbox|lockToken/,
      );
      expect(cancelWorkflowRunResponseSchema.parse(await (await post()).json())).toEqual(response);
    },
  );

  it('Cancel 产品 HTTP：waiting Review 收尾，不生成 reject，旧 token 不可 resume', async () => {
    await startWorker();
    await applications[0]!.app.get(WorkflowExecutionQueue).queue.resume();
    const f = await waiting();
    const response = await fetch(
      `${applications[0]!.base}/api/v1/projects/${f.projectId}/workflows/${f.run.workflowId}/runs/${f.run.id}/cancel`,
      {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookieA, 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(response.status).toBe(200);
    expect(cancelWorkflowRunResponseSchema.parse(await response.json())).toMatchObject({
      outcome: 'cancelled',
      run: { status: 'cancelled' },
    });
    expect((await pending(f.run.id)).items).toEqual([]);
    await failure(
      await api(0, `/${f.run.id}/resume`, 'POST', reviewBody(f.review)),
      409,
      'WORKFLOW_RUN_NOT_WAITING',
    );
    expect(
      await db.nodeRun.findMany({
        where: { workflowRunId: f.run.id },
        select: { nodeId: true, status: true, outputs: true, error: true },
      }),
    ).toEqual([{ nodeId: 'first', status: 'cancelled', outputs: null, error: null }]);
  });
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
  ])('调用契约 %s 在受理前拒绝，数据库中无 Run / Outbox', async (code, inputs) => {
    const f = await version(false, [{ name: 'count', type: NumberType, required: true }]);
    const error = await failure(
      await api(0, '', 'POST', {
        workflowVersionId: f.workflowVersionId,
        invocationKey: randomUUID(),
        inputs,
      }),
      400,
      code,
    );
    expect(JSON.stringify(error)).not.toContain('private-invalid-value');
    expect(await db.workflowRun.count({ where: { projectId: f.projectId } })).toBe(0);
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRun: { projectId: f.projectId } },
      }),
    ).toBe(0);
  });

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
        invocationKey: randomUUID(),
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
        {
          workflowVersionId: f.workflowVersionId,
          invocationKey: randomUUID(),
          inputs: {},
        },
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
      await api(1, `/${f.run.id}/resume`, 'POST', reviewBody(f.review), cookieB),
      404,
      'WORKFLOW_RUN_NOT_FOUND',
    );
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRunId: f.run.id },
      }),
    ).toBe(before);
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
      'waiting',
    );
  });

  it('两个审核周期通过各自 target / revision 恢复原版本 / thread', async () => {
    const f = await waiting();
    const original = await db.workflowRun.findUniqueOrThrow({
      where: { id: f.run.id },
    });
    await result(await api(1, `/${f.run.id}/resume`, 'POST', reviewBody(f.review)), 202);
    await waitRun(f.run.id, 'waiting', 2);
    await result(
      await api(
        0,
        `/${f.run.id}/resume`,
        'POST',
        reviewBody((await pending(f.run.id)).items[0]!, {
          action: 'reject',
          feedback: '第二轮需要修改',
        }),
      ),
      202,
    );
    await waitRun(f.run.id, 'completed');
    expect(await result(await api(1, `/${f.run.id}`))).toMatchObject({
      status: 'completed',
      outputs: { first: { value: 'approve' }, second: { value: 'reject' } },
    });
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
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
        api(0, `/${f.run.id}/resume`, 'POST', reviewBody(f.review)),
        api(1, `/${f.run.id}/resume`, 'POST', reviewBody(f.review, { action: 'reject' })),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
      for (const response of responses)
        if (response.status === 202) await result(response, 202);
        else await failure(response, 409, 'WORKFLOW_RESUME_ALREADY_SUBMITTED');
      expect(
        await db.workflowExecutionOutbox.count({
          where: { workflowRunId: f.run.id, kind: 'resume' },
        }),
      ).toBe(1);
      expect((await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
        'waiting',
      );
    } finally {
      await queue.queue.resume();
    }
    await waitRun(f.run.id, 'waiting', 2);
  });

  it('Pending 返回固定版本节点名、纯文本和说明；非 waiting 为空，读取必须授权', async () => {
    const f = await waiting();
    expect(f.review).toEqual({
      interruptId: expect.any(String),
      waitingRevision: 1,
      node: { id: 'first', name: '人物设定审核' },
      content: 'first 审核文本',
      instruction: '请核对内容',
      submissionStatus: 'pending',
    });
    await failure(
      await api(0, `/${f.run.id}/pending-human-reviews`, 'GET', undefined, null),
      401,
      'HTTP_401',
    );
    await failure(
      await api(0, `/${f.run.id}/pending-human-reviews`, 'GET', undefined, cookieB),
      404,
      'WORKFLOW_RUN_NOT_FOUND',
    );
    const identity = await version();
    const run = await result(
      await api(0, '', 'POST', {
        workflowVersionId: identity.workflowVersionId,
        invocationKey: randomUUID(),
        inputs: {},
      }),
      202,
    );
    expect(await pending(run.id)).toEqual({ items: [] });
  });

  it.each(['revision', 'interrupt'] as const)('拒绝 stale %s，不创建恢复意图', async (kind) => {
    const f = await waiting();
    const request = reviewBody(f.review);
    if (kind === 'revision') request.expectedWaitingRevision++;
    else request.interruptId = '伪造或旧 interrupt';
    await failure(await api(0, `/${f.run.id}/resume`, 'POST', request), 409, 'HUMAN_REVIEW_STALE');
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRunId: f.run.id, kind: 'resume' },
      }),
    ).toBe(0);
    expect((await pending(f.run.id)).items[0]!.submissionStatus).toBe('pending');
  });

  it('已提交但 Worker 尚未 claim：submitted；相同或不同 decision 均 409 且不覆盖', async () => {
    const f = await waiting();
    const queue = applications[0]!.app.get(WorkflowExecutionQueue);
    await queue.queue.pause();
    const request = reviewBody(f.review, {
      action: 'reject',
      feedback: '保留原始修改意见',
    });
    try {
      await result(await api(0, `/${f.run.id}/resume`, 'POST', request), 202);
      const review = (await pending(f.run.id, 1)).items[0]!;
      expect(review).toEqual({ ...f.review, submissionStatus: 'submitted' });
      expect((await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
        'waiting',
      );
      const intent = await db.workflowExecutionOutbox.findFirstOrThrow({
        where: { workflowRunId: f.run.id, kind: 'resume' },
      });
      expect(intent.payload).toMatchObject({
        value: {
          kind: 'targeted_interrupt',
          interruptId: f.review.interruptId,
          value: request.value,
        },
      });
      for (const body of [request, reviewBody(f.review, { action: 'approve' })])
        await failure(
          await api(1, `/${f.run.id}/resume`, 'POST', body),
          409,
          'WORKFLOW_RESUME_ALREADY_SUBMITTED',
        );
      expect(
        await db.workflowExecutionOutbox.count({
          where: { workflowRunId: f.run.id, kind: 'resume' },
        }),
      ).toBe(1);
      expect(
        (
          await db.workflowExecutionOutbox.findUniqueOrThrow({
            where: { id: intent.id },
          })
        ).payload,
      ).toEqual(intent.payload);
    } finally {
      await queue.queue.resume();
    }
    await waitRun(f.run.id, 'waiting', 2);
    const next = (await pending(f.run.id)).items[0]!;
    expect(next.waitingRevision).toBe(2);
    expect(next.node.id).toBe('second');
    expect(next.interruptId).not.toBe(f.review.interruptId);
    await failure(await api(0, `/${f.run.id}/resume`, 'POST', request), 409, 'HUMAN_REVIEW_STALE');
    await failure(
      await api(0, `/${f.run.id}/resume`, 'POST', {
        ...request,
        expectedWaitingRevision: 2,
      }),
      409,
      'HUMAN_REVIEW_STALE',
    );
    expect((await pending(f.run.id)).items[0]!.submissionStatus).toBe('pending');
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRunId: f.run.id, kind: 'resume', waitingRevision: 2 },
      }),
    ).toBe(0);
    const audit = await db.nodeRun.findFirstOrThrow({
      where: { workflowRunId: f.run.id, nodeId: 'first' },
    });
    expect(audit.outputs).toMatchObject({
      action: { value: 'reject' },
      feedback: { value: request.value.feedback },
    });
  });

  it('恢复投递结果不明仍可查询 submitted，刷新不能盲目重复审批', async () => {
    const f = await waiting();
    const queue = applications[0]!.app.get(WorkflowExecutionQueue);
    await queue.queue.pause();
    const publish = vi
      .spyOn(queue, 'publish')
      .mockRejectedValueOnce(new Error('private-queue-error'));
    try {
      const error = await failure(
        await api(0, `/${f.run.id}/resume`, 'POST', reviewBody(f.review)),
        503,
        'WORKFLOW_QUEUE_UNAVAILABLE',
      );
      expect(JSON.stringify(error)).not.toContain('private-queue-error');
      expect((await pending(f.run.id)).items[0]!.submissionStatus).toBe('submitted');
      await failure(
        await api(0, `/${f.run.id}/resume`, 'POST', reviewBody(f.review)),
        409,
        'WORKFLOW_RESUME_ALREADY_SUBMITTED',
      );
    } finally {
      publish.mockRestore();
      await queue.queue.resume();
    }
    await waitRun(f.run.id, 'waiting', 2);
  });

  it.each(['unknown', 'malformed', 'reference', 'node', 'multiple', 'identity'] as const)(
    'checkpoint %s 明确拒绝，不泄漏内部状态',
    async (kind) => {
      const f = await waiting();
      const saved = await db.workflowRun.findUniqueOrThrow({
        where: { id: f.run.id },
      });
      const saver = applications[0]!.app.get(WorkflowCheckpointerService).saver;
      const tuple = await saver.getTuple({
        configurable: { thread_id: saved.threadId },
      });
      if (!tuple) throw new Error('缺少测试 checkpoint');
      const value: Record<string, unknown> = {
        kind: 'human_review',
        schemaVersion: 1,
        nodeId: 'first',
        content: {
          storage: 'inline',
          type: StringType,
          value: 'private-checkpoint-marker',
        },
      };
      if (kind === 'unknown') value.kind = 'other';
      if (kind === 'malformed') value.schemaVersion = 2;
      if (kind === 'reference')
        value.content = {
          storage: 'reference',
          type: StringType,
          reference: { kind: 'artifact', id: 'private-artifact' },
        };
      if (kind === 'node') value.nodeId = 'not-in-version';
      const interrupts = [{ id: f.review.interruptId, value }];
      if (kind === 'multiple') interrupts.push({ id: 'other', value });
      const channel_values =
        kind === 'identity'
          ? {
              ...tuple.checkpoint.channel_values,
              run: { workflowRunId: 'other' },
            }
          : tuple.checkpoint.channel_values;
      const read = vi.spyOn(saver, 'getTuple').mockResolvedValueOnce({
        ...tuple,
        checkpoint: { ...tuple.checkpoint, channel_values },
        pendingWrites: interrupts.map((interrupt, index) => [
          `private-task-${index}`,
          INTERRUPT,
          interrupt,
        ]),
      });
      try {
        const code =
          kind === 'unknown'
            ? 'HUMAN_REVIEW_INTERRUPT_UNSUPPORTED'
            : kind === 'multiple'
              ? 'HUMAN_REVIEW_CAPABILITY_UNSUPPORTED'
              : 'HUMAN_REVIEW_INTERRUPT_INVALID';
        const error = await failure(await api(0, `/${f.run.id}/pending-human-reviews`), 409, code);
        expect(JSON.stringify(error)).not.toMatch(
          /private-checkpoint|private-task|private-artifact|threadId|checkpoint_ns/,
        );
      } finally {
        read.mockRestore();
      }
    },
  );

  it('HTTP 只接受 V1 decision，裸 value / 非法 action / 身份注入均不创建意图', async () => {
    const f = await waiting();
    const base = reviewBody(f.review);
    for (const body of [
      { value: { action: 'approve' } },
      { ...base, value: 0 },
      { ...base, value: { action: 'comment' } },
      { ...base, value: { action: 'reject', feedback: 1 } },
      { ...base, value: { action: 'approve', approved: true } },
      { ...base, threadId: 'injected' },
      { ...base, expectedWaitingRevision: 0 },
    ])
      await failure(await api(0, `/${f.run.id}/resume`, 'POST', body), 400, 'VALIDATION_FAILED');
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRunId: f.run.id, kind: 'resume' },
      }),
    ).toBe(0);
  });

  it('严格校验 start / resume 字段，不能指定 thread、身份、版本副本或省略 value', async () => {
    const f = await version();
    for (const key of ['threadId', 'projectId', 'workflowId', 'status', 'definition'])
      await failure(
        await api(0, '', 'POST', {
          workflowVersionId: f.workflowVersionId,
          invocationKey: randomUUID(),
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
    expect(await db.workflowRun.count({ where: { projectId: f.projectId } })).toBe(0);
  });

  it('Redis 已接受但 confirmation 丢失：503 带受理身份，同 key 跨 API 重试复用 Run / Outbox', async () => {
    const identity = await version();
    const request = {
      workflowVersionId: identity.workflowVersionId,
      invocationKey: randomUUID(),
      inputs: {},
    };
    const queue = applications[0]!.app.get(WorkflowExecutionQueue);
    await queue.queue.pause();
    const original = queue.publish.bind(queue);
    const publish = vi.spyOn(queue, 'publish').mockImplementationOnce(async (job) => {
      await original(job);
      throw new Error('redis-secret-marker');
    });
    try {
      const error = await failure(
        await api(0, '', 'POST', request),
        503,
        'WORKFLOW_QUEUE_UNAVAILABLE',
      );
      expect(JSON.stringify(error)).not.toContain('secret-marker');
      const run = await db.workflowRun.findFirstOrThrow({
        where: { projectId: identity.projectId },
      });
      expect(error).toMatchObject({
        workflowRunId: run.id,
        invocationKey: request.invocationKey,
      });
      expect(
        await queue.queue.getJob(workflowExecutionJobId({ kind: 'start', workflowRunId: run.id })),
      ).toBeDefined();
      publish.mockRestore();
      const repeated = await result(await api(1, '', 'POST', request), 202);
      expect(repeated).toMatchObject({
        id: run.id,
        invocationKey: request.invocationKey,
        status: 'pending',
      });
      expect(
        await db.workflowRun.count({
          where: { projectId: identity.projectId },
        }),
      ).toBe(1);
      expect(
        await db.workflowExecutionOutbox.count({
          where: { workflowRunId: run.id },
        }),
      ).toBe(1);
      await queue.queue.resume();
      await waitRun(run.id, 'completed');
      expect(await result(await api(0, '', 'POST', request), 202)).toMatchObject({
        id: run.id,
        status: 'completed',
      });
    } finally {
      publish.mockRestore();
      await queue.queue.resume();
    }
  });

  it('Start key 必填；等价对象输入可复用，差异返回 409 且不新增执行意图', async () => {
    const identity = await version(false, [{ name: 'a', type: AnyType, required: false }]);
    await failure(
      await api(0, '', 'POST', {
        workflowVersionId: identity.workflowVersionId,
        inputs: {},
      }),
      400,
      'VALIDATION_FAILED',
    );
    const key = randomUUID();
    const request = {
      workflowVersionId: identity.workflowVersionId,
      invocationKey: key,
      inputs: {
        a: { storage: 'inline', type: AnyType, value: { x: 1, y: [2, 3] } },
      },
    };
    const original = await result(await api(0, '', 'POST', request), 202);
    const repeated = await result(
      await api(1, '', 'POST', {
        ...request,
        inputs: {
          a: { value: { y: [2, 3], x: 1 }, type: AnyType, storage: 'inline' },
        },
      }),
      202,
    );
    expect(repeated.id).toBe(original.id);
    const conflict = await failure(
      await api(0, '', 'POST', { ...request, inputs: {} }),
      409,
      'WORKFLOW_INVOCATION_CONFLICT',
    );
    expect(conflict.workflowRunId).toBe(original.id);
    expect(await db.workflowRun.count({ where: { projectId: identity.projectId } })).toBe(1);
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRunId: original.id },
      }),
    ).toBe(1);
  });
});
