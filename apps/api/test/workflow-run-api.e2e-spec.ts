import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  ImageType,
  NumberType,
  workflowRunResponseSchema,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  WorkflowCheckpointerService,
  WorkflowRunRepositories,
  WorkflowRuntimeFactory,
  WorkflowVersionRepositories,
} from '@dramaflow/server';
import {
  DefaultRuntimeValueCodec,
  DefaultWorkflowOutputResolver,
  DefaultWorkflowRunner,
  NodeExecutionError,
  NodeRegistry,
  type WorkflowCompiler,
} from '@dramaflow/workflow';
import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthService } from '../src/auth/auth.service.js';
import { mountAuth } from '../src/auth/auth.http.js';
import { authBaseUrl } from '../src/auth/trusted-origin.js';
import { ApiExceptionFilter } from '../src/http/exception.filter.js';
import { WorkflowService } from '../src/workflow/workflows/workflow.service.js';
import {
  persistentTestCompiler,
  persistentTestDefinition,
} from './fixtures/persistent-workflow-compiler.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test'
)
  throw new Error('Run HTTP 集成测试仅允许在 DramaFlow 的隔离测试数据库运行');

const database = new DatabaseService();
const db = database.client;
const applications: Awaited<ReturnType<typeof application>>[] = [];
const userIds: string[] = [];
let ownerId: string;
let cookieA: string;
let cookieB: string;
const origin = new URL(authBaseUrl()).origin;
const invocations: { threadId: string; resume: boolean }[] = [];
interface Plan {
  gate?: () => Promise<void>;
  fail?: (run: WorkflowRun, app: NestExpressApplication) => Promise<never>;
}
const plans = new Map<string, Plan>();

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
  const base = await app.getUrl();
  const factory = app.get(WorkflowRuntimeFactory);
  const production = factory.forProject.bind(factory);
  // 只有显式测试项目使用原生 interrupt / 故障图；普通空图仍走完整生产 factory。
  // 不覆盖 AuthGuard、Runtime Service、Repository 或 Saver，也不向生产 Registry 注册节点。
  const assemble = vi
    .spyOn(factory, 'forProject')
    .mockImplementation(async (owner, projectId) => {
      const plan = plans.get(projectId);
      if (!plan) return production(owner, projectId);
      const native = persistentTestCompiler(
        app.get(WorkflowCheckpointerService),
        async (event) => {
          invocations.push(event);
        },
      );
      const compiler: WorkflowCompiler = {
        async compile(definition, run) {
          const graph = await native.compile(definition, run);
          const fail = plan.fail;
          if (!fail) return graph;
          return { ...graph, invoke: () => fail(run, app) };
        },
      };
      const runs = await app
        .get(WorkflowRunRepositories)
        .forProject(owner, projectId);
      const read = runs.getById.bind(runs);
      runs.getById = async (id) => {
        const run = await read(id);
        if (run?.status === 'waiting') await plan.gate?.();
        return run;
      };
      return new DefaultWorkflowRunner(
        await app.get(WorkflowVersionRepositories).forProject(owner, projectId),
        runs,
        compiler,
        new DefaultWorkflowOutputResolver(),
      );
    });
  return { app, auth, base, assemble };
}

beforeAll(async () => {
  applications.push(await application());
  applications.push(await application());
  const password = randomBytes(24).toString('hex');
  for (const name of ['A', 'B']) {
    const email = `run-api-${randomUUID()}@example.test`;
    const auth = applications[0]!.auth.auth;
    const { user } = await auth.api.createUser({
      body: { email, name: `Run API ${name}`, password, role: 'user' },
    });
    userIds.push(user.id);
    // 使用真实密码 / 持久化会话与签名 Cookie；不伪造 Guard 或 session。
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
  vi.restoreAllMocks();
  try {
    const runs = await db.workflowRun.findMany({
      where: { project: { ownerId: { in: userIds } } },
      select: { threadId: true },
    });
    for (const run of runs)
      await applications[0]?.app
        .get(WorkflowCheckpointerService)
        .saver.deleteThread(run.threadId);
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
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

async function result(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const run = workflowRunResponseSchema.parse(await response.json());
  expect(run).not.toHaveProperty('threadId');
  expect(run).not.toHaveProperty('projectId');
  return run;
}

async function failure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const error = z
    .object({
      code: z.string(),
      message: z.string(),
      requestId: z.uuid(),
      details: z.unknown().optional(),
    })
    .strict()
    .parse(await response.json());
  expect(error.code).toBe(code);
  expect(error).not.toHaveProperty('stack');
  expect(error).not.toHaveProperty('cause');
  return error;
}

async function version(
  definition: WorkflowDefinition = {
    inputs: [],
    nodes: [],
    edges: [],
    outputs: [],
  },
) {
  const project = await db.project.create({
    data: { ownerId, name: 'Run HTTP', viewport: {} },
  });
  const workflow = await db.workflow.create({
    data: {
      projectId: project.id,
      name: 'Run HTTP',
      draft: z.record(z.string(), z.json()).parse(definition),
    },
  });
  const published = await new WorkflowService(database).publish(ownerId, {
    workflowId: workflow.id,
    expectedRevision: 1,
  });
  return {
    projectId: project.id,
    workflowId: workflow.id,
    workflowVersionId: published.id,
  };
}

async function waiting() {
  const identity = await version(persistentTestDefinition());
  const plan: Plan = {};
  plans.set(identity.projectId, plan);
  const started = await result(
    await api(0, '', 'POST', {
      workflowVersionId: identity.workflowVersionId,
      inputs: { seed: { storage: 'inline', type: NumberType, value: 10 } },
    }),
    201,
  );
  expect(started.status).toBe('waiting');
  const persisted = await db.workflowRun.findUniqueOrThrow({
    where: { id: started.id },
  });
  return { ...identity, started, persisted, plan };
}

describe('真实 Workflow Run HTTP API', () => {
  it('三个入口默认鉴权，未登录时不进入 Runtime；写入继续检查 Origin', async () => {
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
    expect(applications[0]!.assemble).not.toHaveBeenCalled();
  });

  it('仅提交真实版本和 inputs，经生产 Service / Runner / PostgreSQL 完成，再 GET 相同 DTO', async () => {
    const identity = await version({
      inputs: [{ name: 'novel', type: { kind: 'primitive', name: 'string' } }],
      nodes: [],
      edges: [],
      outputs: [],
    });
    const inputs = {
      novel: {
        storage: 'inline',
        type: { kind: 'primitive', name: 'string' },
        value: '测试正文',
      },
    };
    const run = await result(
      await api(0, '', 'POST', {
        workflowVersionId: identity.workflowVersionId,
        inputs,
      }),
      201,
    );
    expect(run).toMatchObject({
      workflowId: identity.workflowId,
      workflowVersionId: identity.workflowVersionId,
      inputs,
      outputs: {},
      status: 'completed',
    });
    const stored = await db.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(stored).toMatchObject({ ...identity, status: 'completed' });
    expect(stored.threadId).not.toBe(run.id);
    expect(await result(await api(1, `/${run.id}`), 200)).toEqual(run);
    expect(
      await applications[1]!.app
        .get(WorkflowCheckpointerService)
        .saver.getTuple({ configurable: { thread_id: stored.threadId } }),
    ).toBeDefined();
    expect(applications[0]!.app.get(NodeRegistry).listManifests()).toEqual([]);
  });

  it('拒绝身份拼接、状态及完整定义，start / resume 均使用严格请求协议', async () => {
    const identity = await version();
    for (const key of [
      'projectId',
      'workflowId',
      'threadId',
      'status',
      'ownerId',
      'definition',
    ])
      await failure(
        await api(0, '', 'POST', {
          workflowVersionId: identity.workflowVersionId,
          inputs: {},
          [key]: 'forged',
        }),
        400,
        'VALIDATION_FAILED',
      );
    await failure(
      await api(0, '', 'POST', {
        workflowVersionId: identity.workflowVersionId,
      }),
      400,
      'VALIDATION_FAILED',
    );
    await failure(
      await api(0, '/missing/resume', 'POST', {}),
      400,
      'VALIDATION_FAILED',
    );
    await failure(
      await api(0, '/missing/resume', 'POST', { value: 1, threadId: 'forged' }),
      400,
      'VALIDATION_FAILED',
    );
    expect(
      await db.workflowRun.count({ where: { projectId: identity.projectId } }),
    ).toBe(0);
  });

  it('缺失 / 无权版本及运行统一为 404，HTTP 权限拒绝发生在 Runner 之前', async () => {
    const f = await waiting();
    const before = applications[0]!.assemble.mock.calls.length;
    const missingVersion = await failure(
      await api(0, '', 'POST', { workflowVersionId: 'missing', inputs: {} }),
      404,
      'WORKFLOW_VERSION_NOT_FOUND',
    );
    const hiddenVersion = await failure(
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
    expect(hiddenVersion.message).toBe(missingVersion.message);
    for (const [path, method, body] of [
      [`/${f.started.id}`, 'GET', undefined],
      [`/${f.started.id}/resume`, 'POST', { value: 1 }],
    ] as const)
      await failure(
        await api(0, path, method, body, cookieB),
        404,
        'WORKFLOW_RUN_NOT_FOUND',
      );
    await failure(await api(0, '/missing'), 404, 'WORKFLOW_RUN_NOT_FOUND');
    await failure(
      await api(0, '/missing/resume', 'POST', { value: 1 }),
      404,
      'WORKFLOW_RUN_NOT_FOUND',
    );
    expect(applications[0]!.assemble.mock.calls.length).toBe(before);
    expect(
      await db.workflowRun.findUniqueOrThrow({ where: { id: f.started.id } }),
    ).toMatchObject({ status: 'waiting', threadId: f.persisted.threadId });
  });

  it('HTTP start → waiting；另一 API 实例从原版本 / thread 的 PostgreSQL checkpoint 恢复并 GET outputs', async () => {
    const f = await waiting();
    const future = persistentTestDefinition();
    const output = future.outputs[0];
    if (!output) throw new Error('测试定义没有输出');
    output.name = 'futureAnswer';
    const workflows = new WorkflowService(database);
    await workflows.updateDraft(ownerId, {
      workflowId: f.workflowId,
      expectedRevision: 1,
      definition: future,
    });
    await workflows.publish(ownerId, {
      workflowId: f.workflowId,
      expectedRevision: 2,
    });
    const run = await result(
      await api(1, `/${f.started.id}/resume`, 'POST', { value: 20 }),
      200,
    );
    expect(run).toMatchObject({
      id: f.started.id,
      workflowVersionId: f.workflowVersionId,
      status: 'completed',
      outputs: { answer: { value: 31 } },
    });
    expect(run.startedAt).toBe(f.started.startedAt);
    expect(await result(await api(0, `/${run.id}`), 200)).toEqual(run);
    expect(
      invocations.filter((event) => event.threadId === f.persisted.threadId),
    ).toEqual([
      { threadId: f.persisted.threadId, resume: false },
      { threadId: f.persisted.threadId, resume: true },
    ]);
    expect(
      await db.workflowRun.count({ where: { projectId: f.projectId } }),
    ).toBe(1);
    expect(
      await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({
      threadId: f.persisted.threadId,
      workflowVersionId: f.workflowVersionId,
    });
    await failure(
      await api(0, `/${run.id}/resume`, 'POST', { value: 1 }),
      409,
      'WORKFLOW_RUN_NOT_WAITING',
    );
  });

  it('两个真实 HTTP resume 都读到 waiting，仅一个进入 Graph，另一个返回 409', async () => {
    const f = await waiting();
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.plan.gate = async () => {
      if (++arrivals === 2) release();
      await gate;
    };
    const responses = await Promise.all([
      api(0, `/${f.started.id}/resume`, 'POST', { value: 5 }),
      api(1, `/${f.started.id}/resume`, 'POST', { value: 7 }),
    ]);
    expect(arrivals).toBe(2);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    for (const response of responses)
      if (response.status === 200)
        expect((await result(response, 200)).status).toBe('completed');
      else await failure(response, 409, 'WORKFLOW_RUN_NOT_WAITING');
    expect(
      invocations.filter(
        (event) => event.threadId === f.persisted.threadId && event.resume,
      ),
    ).toHaveLength(1);
  });

  it('数值 0 的 resume 保持原值，不被当作缺少请求参数', async () => {
    const f = await waiting();
    const run = await result(
      await api(1, `/${f.started.id}/resume`, 'POST', { value: 0 }),
      200,
    );
    expect(run.outputs).toMatchObject({ answer: { value: 11 } });
  });

  it.each(['node', 'reference', 'artifact'] as const)(
    '%s 运行错误返回安全摘要，不暴露 cause / stack / 上游内容',
    async (kind) => {
      const f = await version(persistentTestDefinition());
      plans.set(f.projectId, {
        async fail(run, app) {
          if (kind === 'node')
            throw new NodeExecutionError(
              'private-node',
              'private-type',
              'execute',
              new Error('provider-secret-test-value'),
            );
          const codec = app.get(DefaultRuntimeValueCodec);
          if (kind === 'reference')
            await codec.decode(
              {
                storage: 'reference',
                type: ImageType,
                reference: {
                  kind: 'asset',
                  id: 'private-asset',
                  versionId: 'v3',
                },
              },
              { projectId: run.projectId, workflowRunId: run.id },
            );
          else
            await codec.encode(
              { private: 'provider-secret-test-value' },
              {
                type: ImageType,
                storagePolicy: 'reference',
                context: {
                  projectId: run.projectId,
                  workflowRunId: run.id,
                  nodeId: 'node',
                  outputKey: 'image',
                },
              },
            );
          throw new Error('未配置内容能力没有拒绝执行');
        },
      });
      const code =
        kind === 'node'
          ? 'NODE_EXECUTION_FAILED'
          : kind === 'reference'
            ? 'REFERENCE_RUNTIME_NOT_CONFIGURED'
            : 'ARTIFACT_WRITER_NOT_CONFIGURED';
      const error = await failure(
        await api(0, '', 'POST', {
          workflowVersionId: f.workflowVersionId,
          inputs: {},
        }),
        kind === 'node' ? 500 : 503,
        code,
      );
      expect(JSON.stringify(error)).not.toMatch(
        /private-|provider-secret|stack|cause/,
      );
      const stored = await db.workflowRun.findFirstOrThrow({
        where: { projectId: f.projectId },
      });
      const failed = await result(await api(0, `/${stored.id}`), 200);
      expect(failed).toMatchObject({
        status: 'failed',
        error: { stage: 'invoke' },
      });
      expect(JSON.stringify(failed)).not.toMatch(
        /private-|provider-secret|stack|cause/,
      );
    },
  );
});
