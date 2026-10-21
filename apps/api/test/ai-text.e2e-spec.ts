import 'reflect-metadata';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  StringType,
  workflowRunResponseSchema,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  ModelProviderService,
  WorkflowCheckpointerService,
  WorkflowExecutionQueue,
  workflowExecutionJobId,
} from '@dramaflow/server';
import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthService } from '../src/auth/auth.service.js';
import { mountAuth } from '../src/auth/auth.http.js';
import { authBaseUrl } from '../src/auth/trusted-origin.js';
import { ApiExceptionFilter } from '../src/http/exception.filter.js';
import { storeRuntimeTestVersion } from './fixtures/workflow-service.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test' ||
  !process.env.WORKFLOW_QUEUE_PREFIX?.startsWith('dramaflow-test-')
)
  throw new Error('文本 AI 集成测试仅允许独立测试库与队列');

// 该本机服务只证明 OpenAI-compatible HTTP 协议适配，不能证明真实外部模型质量或可用性。
// 不读取任何真实 Provider 凭证，也不发起收费模型请求。
const credential = `test-only-ai-key-${randomUUID()}`;
const requestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});
const calls: Array<{
  path: string;
  authorization: string | undefined;
  body: z.infer<typeof requestSchema>;
}> = [];
const protocolServer = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const body = requestSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    calls.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      body,
    });
    response.setHeader('Content-Type', 'application/json');
    if (body.model.startsWith('failure-')) {
      response.writeHead(503);
      response.end(
        JSON.stringify({
          error: {
            message: `upstream-error-must-not-leak-${credential}`,
            type: 'server_error',
            code: 'unavailable',
          },
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '人物走入雨中的场景。' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
      }),
    );
  } catch {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: '测试协议请求不合法' } }));
  }
});
const database = new DatabaseService();
const db = database.client;
const userIds: string[] = [];
const cookies = new Map<string, string>();
let ownerId: string;
let outsiderId: string;
let app: NestExpressApplication;
let providers: ModelProviderService;
let apiBase: string;
let providerBase: string;
let worker: ChildProcess | undefined;
let workerLog = '';
const origin = new URL(authBaseUrl()).origin;

async function startWorker() {
  const child = fork(
    fileURLToPath(
      new URL('./fixtures/ai-text-worker-process.ts', import.meta.url),
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
    ready =
      z.object({ event: z.literal('ready'), pid: z.number() }).parse(value)
        .event === 'ready';
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-3000);
    workerLog += chunk.toString();
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    workerLog += chunk.toString();
  });
  await vi.waitFor(
    () => {
      if (child.exitCode !== null)
        throw new Error(`正式文本 AI Worker 启动失败：${stderr}`);
      expect(ready).toBe(true);
    },
    { timeout: 15000 },
  );
}

beforeAll(async () => {
  await new Promise<void>((resolve) =>
    protocolServer.listen(0, '127.0.0.1', resolve),
  );
  const address = protocolServer.address();
  if (!address || typeof address === 'string')
    throw new Error('本机协议服务未就绪');
  providerBase = `http://127.0.0.1:${address.port}/v1`;
  const constructor = z.custom<Type<unknown>>(
    (value) => typeof value === 'function',
  );
  const source: unknown = await import(
    new URL('../dist/app.module.js', import.meta.url).href
  );
  const authSource: unknown = await import(
    new URL('../dist/auth/auth.service.js', import.meta.url).href
  );
  const { AppModule } = z.object({ AppModule: constructor }).parse(source);
  const { AuthService: AuthToken } = z
    .object({ AuthService: constructor })
    .parse(authSource);
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
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
  apiBase = await app.getUrl();
  providers = app.get(ModelProviderService);
  await app.get(WorkflowExecutionQueue).queue.pause();
  const password = randomBytes(24).toString('hex');
  for (const name of ['owner', 'outsider']) {
    const email = `ai-text-${randomUUID()}@example.test`;
    const { user } = await auth.auth.api.createUser({
      body: { email, name, password, role: 'user' },
    });
    userIds.push(user.id);
    const response = await auth.auth.api.signInEmail({
      body: { email, password, rememberMe: true },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    cookies.set(
      user.id,
      response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    );
    if (name === 'owner') ownerId = user.id;
    else outsiderId = user.id;
  }
  await startWorker();
  await app.get(WorkflowExecutionQueue).queue.resume();
});

afterAll(async () => {
  try {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.send({ event: 'close' });
      await vi.waitFor(() => expect(worker?.exitCode).not.toBeNull(), {
        timeout: 10000,
      });
    }
    const runs = await db.workflowRun.findMany({
      where: { project: { ownerId: { in: userIds } } },
      select: { threadId: true },
    });
    for (const run of runs)
      await app
        ?.get(WorkflowCheckpointerService)
        .saver.deleteThread(run.threadId);
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await app?.get(WorkflowExecutionQueue).queue.obliterate({ force: true });
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null)
      worker.kill('SIGKILL');
    await app?.close();
    await database.onModuleDestroy();
    await new Promise<void>((resolve, reject) =>
      protocolServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function project(owner = ownerId) {
  return db.project.create({
    data: { ownerId: owner, name: '文本 AI', viewport: {} },
  });
}
async function configured(projectId: string, model = `model-${randomUUID()}`) {
  const provider = await providers.createProvider(ownerId, {
    projectId,
    name: '显式选择的兼容协议实例',
    pluginId: 'openai_compatible',
    pluginVersion: 1,
    configuration: { baseURL: providerBase },
    credentials: { apiKey: credential },
  });
  const configuration = await providers.createModelConfiguration(ownerId, {
    projectId,
    providerId: provider.id,
    capability: 'text.generate',
    model,
    settings: { temperature: 0, maxOutputTokens: 64 },
  });
  expect(JSON.stringify({ provider, configuration })).not.toContain(credential);
  expect(provider).not.toHaveProperty('encryptedCredentials');
  return { provider, configuration, model };
}
async function published(
  projectId: string,
  modelConfigurationId: string,
  owner = ownerId,
  legacy = false,
) {
  const definition: WorkflowDefinition = {
    inputs: [{ name: 'prompt', type: StringType }],
    nodes: [
      {
        id: 'text',
        type: 'ai.text_generate',
        typeVersion: 1,
        name: '文本生成',
        inputs: {
          prompt: { type: 'workflow_input', key: 'prompt' },
          system: { type: 'constant', value: '用一句话描写场景。' },
        },
        config: { modelConfigurationId },
        ui: { position: { x: 0, y: 0 } },
      },
    ],
    edges: [],
    outputs: [
      {
        name: 'text',
        type: StringType,
        source: { nodeId: 'text', outputKey: 'text' },
      },
    ],
  };
  const workflow = await db.workflow.create({
    data: {
      projectId,
      name: '正式文本 AI',
      draft: z.record(z.string(), z.json()).parse(definition),
    },
  });
  if (legacy) return storeRuntimeTestVersion(database, workflow, definition);
  const response = await fetch(
    `${apiBase}/api/v1/workflows/${workflow.id}/publish`,
    {
      method: 'POST',
      headers: {
        Cookie: cookies.get(owner) ?? '',
        Origin: new URL(authBaseUrl()).origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision: 1 }),
    },
  );
  expect(response.status).toBe(201);
  return z.object({ id: z.string() }).parse(await response.json());
}
async function submit(workflowVersionId: string, owner = ownerId) {
  const response = await fetch(`${apiBase}/api/v1/workflow-runs`, {
    method: 'POST',
    headers: {
      Cookie: cookies.get(owner) ?? '',
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workflowVersionId,
      inputs: {
        prompt: { storage: 'inline', type: StringType, value: '雨夜中的人物' },
      },
    }),
  });
  expect(response.status).toBe(202);
  const body: unknown = await response.json();
  expect(body).not.toHaveProperty('threadId');
  return workflowRunResponseSchema.parse(body);
}
async function terminal(workflowRunId: string, status: 'completed' | 'failed') {
  await vi.waitFor(
    async () => {
      const row = await db.workflowRun.findUniqueOrThrow({
        where: { id: workflowRunId },
      });
      expect(row.status).toBe(status);
      expect(
        await db.workflowExecutionOutbox.findFirst({
          where: { workflowRunId },
        }),
      ).toMatchObject({ status });
    },
    { timeout: 15000 },
  );
  return db.workflowRun.findUniqueOrThrow({ where: { id: workflowRunId } });
}
async function assertSafePersistence(runId: string) {
  const run = await db.workflowRun.findUniqueOrThrow({ where: { id: runId } });
  const version = await db.workflowVersion.findUniqueOrThrow({
    where: { id: run.workflowVersionId },
  });
  const workflow = await db.workflow.findUniqueOrThrow({
    where: { id: run.workflowId },
  });
  const nodeRuns = await db.nodeRun.findMany({
    where: { workflowRunId: runId },
  });
  const intents = await db.workflowExecutionOutbox.findMany({
    where: { workflowRunId: runId },
  });
  for (const value of [run, version, workflow, nodeRuns, intents]) {
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain(providerBase);
    expect(serialized).not.toContain('upstream-error-must-not-leak');
    expect(serialized).not.toContain('encryptedCredentials');
  }
  let checkpointCount = 0;
  for await (const tuple of app
    .get(WorkflowCheckpointerService)
    .saver.list({ configurable: { thread_id: run.threadId } })) {
    const serialized = JSON.stringify(tuple);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain(providerBase);
    expect(serialized).not.toContain('upstream-error-must-not-leak');
    expect(serialized).not.toContain('encryptedCredentials');
    checkpointCount++;
  }
  expect(checkpointCount).toBeGreaterThan(0);
  expect(workerLog).not.toContain(credential);
  expect(workerLog).not.toContain('upstream-error-must-not-leak');
  return nodeRuns;
}

describe('正式文本 AI：HTTP → Outbox → BullMQ → 独立 Worker → Provider 协议 → NodeRun', () => {
  it('服务端 CLI 从显式环境变量创建真实加密配置，不调用模型或返回凭证', async () => {
    const p = await project();
    const directory = await mkdtemp(join(tmpdir(), 'dramaflow-provider-e2e-'));
    const file = join(directory, 'provider.json');
    const before = calls.length;
    try {
      await writeFile(
        file,
        JSON.stringify({
          ownerId,
          projectId: p.id,
          name: 'CLI 项目模型',
          pluginId: 'openai_compatible',
          pluginVersion: 1,
          configuration: { baseURL: providerBase },
          credentialsEnv: { apiKey: 'DRAMAFLOW_CLI_AI_TEST_KEY' },
          model: {
            capability: 'text.generate',
            model: 'cli-explicit-model',
            settings: {},
          },
        }),
        { mode: 0o600 },
      );
      const result = await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              '../../../scripts/configure-model-provider.mjs',
              import.meta.url,
            ),
          ),
          file,
        ],
        {
          cwd: directory,
          env: { ...process.env, DRAMAFLOW_CLI_AI_TEST_KEY: credential },
        },
      );
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(credential);
      const ids = z
        .object({ providerId: z.uuid(), modelConfigurationId: z.uuid() })
        .strict()
        .parse(JSON.parse(result.stdout));
      const provider = await db.modelProvider.findUniqueOrThrow({
        where: { id: ids.providerId },
      });
      expect(provider.encryptedCredentials).not.toContain(credential);
      expect(provider.projectId).toBe(p.id);
      expect(
        await providers.getModelConfiguration(
          ownerId,
          p.id,
          ids.modelConfigurationId,
        ),
      ).toMatchObject({
        providerId: ids.providerId,
        model: 'cli-explicit-model',
        capability: 'text.generate',
      });
      expect(
        await providers.getModelConfiguration(
          outsiderId,
          p.id,
          ids.modelConfigurationId,
        ),
      ).toBeNull();
      expect(calls).toHaveLength(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('模型与 endpoint 不可改写、同项目外键不可拼接；显式凭证轮换不改变已发布的模型绑定', async () => {
    const p = await project();
    const other = await project();
    const f = await configured(p.id);
    const version = await published(p.id, f.configuration.id);
    await expect(
      db.modelProvider.update({
        where: { id: f.provider.id },
        data: { configuration: { baseURL: 'https://other.example.test/v1' } },
      }),
    ).rejects.toThrow();
    await expect(
      db.modelConfiguration.update({
        where: { id: f.configuration.id },
        data: { model: 'changed' },
      }),
    ).rejects.toThrow();
    await expect(
      providers.createModelConfiguration(ownerId, {
        projectId: other.id,
        providerId: f.provider.id,
        capability: 'text.generate',
        model: f.model,
        settings: {},
      }),
    ).rejects.toThrow();
    await expect(
      db.modelConfiguration.create({
        data: {
          projectId: other.id,
          providerId: f.provider.id,
          capability: 'text.generate',
          model: f.model,
          settings: {},
        },
      }),
    ).rejects.toThrow();
    const rotated = `rotated-test-only-${randomUUID()}`;
    await expect(
      providers.replaceCredentials(outsiderId, p.id, f.provider.id, {
        apiKey: rotated,
      }),
    ).rejects.toThrow();
    await expect(
      providers.replaceCredentials(ownerId, p.id, f.provider.id, {
        apiKey: '',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_CREDENTIALS_UNAVAILABLE' });
    await providers.replaceCredentials(ownerId, p.id, f.provider.id, {
      apiKey: rotated,
    });
    const run = await terminal((await submit(version.id)).id, 'completed');
    expect(calls.filter((call) => call.body.model === f.model)).toMatchObject([
      { authorization: `Bearer ${rotated}` },
    ]);
    const nodes = await assertSafePersistence(run.id);
    expect(JSON.stringify({ run, nodes, workerLog })).not.toContain(rotated);
    expect(
      await db.workflowVersion.findUniqueOrThrow({ where: { id: version.id } }),
    ).toMatchObject({
      definition: {
        nodes: [{ config: { modelConfigurationId: f.configuration.id } }],
      },
    });
  });

  it('已发布版本引用正式模型配置；真实 Worker 完成输出，凭证仅在调用边界解密', async () => {
    const p = await project();
    const f = await configured(p.id);
    const storedProvider = await db.modelProvider.findUniqueOrThrow({
      where: { id: f.provider.id },
    });
    expect(storedProvider.encryptedCredentials).not.toContain(credential);
    expect(storedProvider.encryptedCredentials.length).toBeGreaterThan(30);
    const version = await published(p.id, f.configuration.id);
    const submitted = await submit(version.id);
    const run = await terminal(submitted.id, 'completed');
    expect(run.outputs).toEqual({
      text: {
        storage: 'inline',
        type: StringType,
        value: '人物走入雨中的场景。',
      },
    });
    const requests = calls.filter((call) => call.body.model === f.model);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: '/v1/chat/completions',
      authorization: `Bearer ${credential}`,
      body: {
        model: f.model,
        messages: [
          { role: 'system', content: '用一句话描写场景。' },
          { role: 'user', content: '雨夜中的人物' },
        ],
      },
    });
    const nodes = await assertSafePersistence(run.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      nodeId: 'text',
      attempt: 1,
      status: 'completed',
      inputs: {
        prompt: { storage: 'inline', value: '雨夜中的人物' },
        system: { storage: 'inline', value: '用一句话描写场景。' },
      },
      outputs: run.outputs,
    });
    const response = await fetch(`${apiBase}/api/v1/workflow-runs/${run.id}`, {
      headers: { Cookie: cookies.get(ownerId) ?? '' },
    });
    expect(response.status).toBe(200);
    expect(
      workflowRunResponseSchema.parse(await response.json()),
    ).toMatchObject({
      status: 'completed',
      outputs: run.outputs,
    });
  });

  it('历史快照中的缺失 / 禁用配置、禁用 Provider 或坏密文仍由 Runtime 拒绝，不请求模型', async () => {
    for (const mode of [
      'missing',
      'model_disabled',
      'provider_disabled',
      'bad_secret',
    ]) {
      const p = await project();
      const f = await configured(p.id);
      if (mode === 'model_disabled')
        await db.modelConfiguration.update({
          where: { id: f.configuration.id },
          data: { enabled: false },
        });
      if (mode === 'provider_disabled')
        await db.modelProvider.update({
          where: { id: f.provider.id },
          data: { enabled: false },
        });
      if (mode === 'bad_secret')
        await db.modelProvider.update({
          where: { id: f.provider.id },
          data: { encryptedCredentials: 'invalid-test-only-ciphertext' },
        });
      const version = await published(
        p.id,
        mode === 'missing' ? randomUUID() : f.configuration.id,
        ownerId,
        true,
      );
      const run = await terminal((await submit(version.id)).id, 'failed');
      const nodes = await assertSafePersistence(run.id);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({
        status: 'failed',
        attempt: 1,
        error: { stage: 'execute', code: 'NODE_EXECUTION_FAILED' },
      });
      expect(calls.filter((call) => call.body.model === f.model)).toHaveLength(
        0,
      );
    }
  });

  it('模型 503 只请求一次，不由 LangChain 或 BullMQ 自动重试，供应商异常内容不持久化', async () => {
    const p = await project();
    const f = await configured(p.id, `failure-${randomUUID()}`);
    const version = await published(p.id, f.configuration.id);
    const run = await terminal((await submit(version.id)).id, 'failed');
    expect(await assertSafePersistence(run.id)).toMatchObject([
      { status: 'failed', attempt: 1, error: { stage: 'execute' } },
    ]);
    const job = await app
      .get(WorkflowExecutionQueue)
      .queue.getJob(
        workflowExecutionJobId({ kind: 'start', workflowRunId: run.id }),
      );
    await vi.waitFor(async () => expect(await job?.getState()).toBe('failed'));
    expect(job?.attemptsMade).toBe(1);
    expect(calls.filter((call) => call.body.model === f.model)).toHaveLength(1);
  });

  it('配置创建与 Worker 解析都隔离项目 / 所有者；同所有者不同项目也不能拼接配置', async () => {
    const source = await project();
    const f = await configured(source.id);
    const otherProject = await project();
    const foreign = await project(outsiderId);
    for (const [owner, projectId] of [
      [ownerId, otherProject.id],
      [outsiderId, foreign.id],
      [outsiderId, source.id],
    ] as const)
      await expect(
        providers.createModelConfiguration(owner, {
          projectId,
          providerId: f.provider.id,
          capability: 'text.generate',
          model: 'forbidden-model',
          settings: {},
        }),
      ).rejects.toThrow();
    await expect(
      providers.createProvider(outsiderId, {
        projectId: source.id,
        name: '禁止访问',
        pluginId: 'openai_compatible',
        pluginVersion: 1,
        configuration: { baseURL: providerBase },
        credentials: { apiKey: credential },
      }),
    ).rejects.toThrow();
    for (const [target, owner] of [
      [otherProject, ownerId],
      [foreign, outsiderId],
    ] as const) {
      const version = await published(
        target.id,
        f.configuration.id,
        owner,
        true,
      );
      const run = await terminal(
        (await submit(version.id, owner)).id,
        'failed',
      );
      expect(await assertSafePersistence(run.id)).toMatchObject([
        { status: 'failed', error: { stage: 'execute' } },
      ]);
    }
    expect(calls.filter((call) => call.body.model === f.model)).toHaveLength(0);
    const protectedVersion = await published(source.id, f.configuration.id);
    const protectedRun = await submit(protectedVersion.id);
    await terminal(protectedRun.id, 'completed');
    for (const suffix of ['', '/resume']) {
      const response = await fetch(
        `${apiBase}/api/v1/workflow-runs/${protectedRun.id}${suffix}`,
        {
          method: suffix ? 'POST' : 'GET',
          headers: {
            Cookie: cookies.get(outsiderId) ?? '',
            ...(suffix
              ? { Origin: origin, 'Content-Type': 'application/json' }
              : {}),
          },
          ...(suffix ? { body: JSON.stringify({ value: true }) } : {}),
        },
      );
      expect(response.status).toBe(404);
    }
  });
});
