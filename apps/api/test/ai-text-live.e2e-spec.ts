import 'reflect-metadata';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
import { NodeRegistry } from '@dramaflow/workflow';
import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthService } from '../src/auth/auth.service.js';
import { mountAuth } from '../src/auth/auth.http.js';
import { authBaseUrl } from '../src/auth/trusted-origin.js';
import { ApiExceptionFilter } from '../src/http/exception.filter.js';
import { createWorkflowService } from './fixtures/workflow-service.js';

// 默认不创建应用、读取供应商凭证或发送模型请求；仅操作员显式启用后才进行一次收费调用。
const enabled = process.env.DRAMAFLOW_LIVE_AI === '1';
const live = enabled ? it : it.skip;
let app: NestExpressApplication | undefined;
let database: DatabaseService | undefined;
let worker: ChildProcess | undefined;
let ownerId: string | undefined;
let workerLog = '';
let credential: string | undefined;
let capabilityFailure:
  { code: string; status?: number; outcome?: string } | undefined;

function assertNoCredential(value: unknown): void {
  if (credential && JSON.stringify(value).includes(credential))
    throw new Error('检测到凭证进入持久化或日志边界');
}

async function startWorker(): Promise<void> {
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
  child.on('message', (value: unknown) => {
    if (
      z.object({ event: z.literal('ready'), pid: z.number() }).safeParse(value)
        .success
    )
      ready = true;
    const summary = z
      .object({
        event: z.literal('capability_failed'),
        code: z.string().regex(/^[A-Z_]+$/),
        status: z.number().int().min(100).max(599).optional(),
        outcome: z.enum(['rejected', 'outcome_unknown']).optional(),
      })
      .safeParse(value);
    if (summary.success) capabilityFailure = summary.data;
  });
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => {
      workerLog += chunk.toString();
    });
  await vi.waitFor(
    () => {
      if (child.exitCode !== null) throw new Error('真实模型 Worker 启动失败');
      expect(ready).toBe(true);
    },
    { timeout: 15000 },
  );
}

afterAll(async () => {
  if (!enabled) return;
  let cleanupFailed = false;
  try {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.send({ event: 'close' });
      try {
        await vi.waitFor(() => expect(worker?.exitCode).not.toBeNull(), {
          timeout: 15000,
        });
      } catch {
        worker.kill('SIGKILL');
        cleanupFailed = true;
      }
    }
    assertNoCredential(workerLog);
    if (database && ownerId) {
      const runs = await database.client.workflowRun.findMany({
        where: { project: { ownerId } },
        select: { id: true, threadId: true },
      });
      for (const run of runs) {
        if (app) {
          await app
            .get(WorkflowCheckpointerService)
            .saver.deleteThread(run.threadId);
          const job = await app
            .get(WorkflowExecutionQueue)
            .queue.getJob(
              workflowExecutionJobId({ kind: 'start', workflowRunId: run.id }),
            );
          await job?.remove();
        }
      }
      await database.client.user.deleteMany({ where: { id: ownerId } });
    }
  } catch {
    cleanupFailed = true;
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null)
      worker.kill('SIGKILL');
    try {
      await app?.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      await database?.onModuleDestroy();
    } catch {
      cleanupFailed = true;
    }
    credential = undefined;
  }
  if (cleanupFailed)
    throw new Error('真实模型测试清理失败，请检查隔离测试资源');
}, 45000);

describe('显式启用：真实外部文本模型端到端验收', () => {
  live(
    '正式 HTTP → Outbox → Queue → Worker → 外部模型 → NodeRun → Workflow Output',
    async () => {
      try {
        if (
          process.env.DRAMAFLOW_INTEGRATION !== '1' ||
          new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
            '/dramaflow_test' ||
          !process.env.WORKFLOW_QUEUE_PREFIX?.startsWith('dramaflow-test-')
        )
          throw new Error('真实模型测试必须使用隔离数据库与测试队列');
        const configuration = z
          .object({
            baseURL: z.url().refine((value) => {
              const url = new URL(value);
              return (
                url.protocol === 'https:' &&
                !url.username &&
                !url.password &&
                !url.search &&
                !url.hash &&
                !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
                !/\.(test|invalid|localhost)$/.test(url.hostname)
              );
            }),
            model: z.string().trim().min(1).max(200),
            credentialEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          })
          .parse({
            baseURL: process.env.DRAMAFLOW_LIVE_AI_BASE_URL,
            model: process.env.DRAMAFLOW_LIVE_AI_MODEL,
            credentialEnv: process.env.DRAMAFLOW_LIVE_AI_CREDENTIAL_ENV,
          });
        credential = process.env[configuration.credentialEnv];
        if (!credential) throw new Error('未配置明确选择的模型凭证');

        const constructor = z.custom<Type<unknown>>(
          (value) => typeof value === 'function',
        );
        const source: unknown = await import(
          new URL('../dist/app.module.js', import.meta.url).href
        );
        const authSource: unknown = await import(
          new URL('../dist/auth/auth.service.js', import.meta.url).href
        );
        const { AppModule } = z
          .object({ AppModule: constructor })
          .parse(source);
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
        const base = await app.getUrl();
        database = new DatabaseService();
        const db = database.client;
        const password = randomBytes(24).toString('hex');
        const email = `ai-live-${randomUUID()}@example.test`;
        const account = await auth.auth.api.createUser({
          body: { email, name: '真实文本模型验收', password, role: 'user' },
        });
        ownerId = account.user.id;
        const login = await auth.auth.api.signInEmail({
          body: { email, password, rememberMe: true },
          asResponse: true,
        });
        expect(login.status).toBe(200);
        const cookie = login.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        const project = await db.project.create({
          data: { ownerId, name: '真实文本模型验收', viewport: {} },
        });
        const providers = app.get(ModelProviderService);
        const provider = await providers.createProvider(ownerId, {
          projectId: project.id,
          name: '操作员明确选择的真实 Provider',
          pluginId: 'openai_compatible',
          pluginVersion: 1,
          configuration: { baseURL: configuration.baseURL, timeoutMs: 120000 },
          credentials: { apiKey: credential },
        });
        const model = await providers.createModelConfiguration(ownerId, {
          projectId: project.id,
          providerId: provider.id,
          capability: 'text.generate',
          model: configuration.model,
          settings: { temperature: 0, maxOutputTokens: 1024 },
        });
        assertNoCredential({ provider, model });
        const definition: WorkflowDefinition = {
          inputs: [{ name: 'prompt', type: StringType, required: true }],
          nodes: [
            {
              id: 'text',
              type: 'ai.text_generate',
              typeVersion: 1,
              name: '正式文本生成',
              inputs: { prompt: { type: 'workflow_input', key: 'prompt' } },
              config: { modelConfigurationId: model.id },
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
            projectId: project.id,
            name: '正式文本生成',
            draft: z.record(z.string(), z.json()).parse(definition),
          },
        });
        const version = await createWorkflowService(
          database,
          app.get(NodeRegistry),
        ).publish(ownerId, {
          workflowId: workflow.id,
          expectedRevision: 1,
        });
        await startWorker();
        const submission = await fetch(`${base}/api/v1/workflow-runs`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: new URL(authBaseUrl()).origin,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            workflowVersionId: version.id,
            invocationKey: randomUUID(),
            inputs: {
              prompt: {
                storage: 'inline',
                type: StringType,
                value: '请只输出这一句短文本：剧本里的角色走入雨夜。',
              },
            },
          }),
        });
        expect(submission.status).toBe(202);
        const submittedBody: unknown = await submission.json();
        assertNoCredential(submittedBody);
        const submitted = workflowRunResponseSchema.parse(submittedBody);
        await vi.waitFor(
          async () => {
            const run = await db.workflowRun.findUniqueOrThrow({
              where: { id: submitted.id },
            });
            expect(['completed', 'failed']).toContain(run.status);
            expect(
              (
                await db.workflowExecutionOutbox.findFirst({
                  where: { workflowRunId: run.id },
                })
              )?.status,
            ).toBe(run.status);
          },
          { timeout: 140000, interval: 250 },
        );
        const run = await db.workflowRun.findUniqueOrThrow({
          where: { id: submitted.id },
        });
        if (run.status !== 'completed') throw new Error('真实文本节点执行失败');
        const nodes = await db.nodeRun.findMany({
          where: { workflowRunId: run.id },
        });
        const intents = await db.workflowExecutionOutbox.findMany({
          where: { workflowRunId: run.id },
        });
        const persistedVersion = await db.workflowVersion.findUniqueOrThrow({
          where: { id: version.id },
        });
        const persistedDraft = await db.workflow.findUniqueOrThrow({
          where: { id: workflow.id },
        });
        for (const value of [
          run,
          nodes,
          intents,
          persistedVersion,
          persistedDraft,
        ])
          assertNoCredential(value);
        let checkpointCount = 0;
        for await (const tuple of app
          .get(WorkflowCheckpointerService)
          .saver.list({ configurable: { thread_id: run.threadId } })) {
          assertNoCredential(tuple);
          checkpointCount++;
        }
        expect(checkpointCount).toBeGreaterThan(0);
        assertNoCredential(workerLog);
        expect(nodes).toHaveLength(1);
        expect(nodes[0]?.status).toBe('completed');
        expect(nodes[0]?.attempt).toBe(1);
        expect(intents).toHaveLength(1);
        const response = await fetch(`${base}/api/v1/workflow-runs/${run.id}`, {
          headers: { Cookie: cookie },
        });
        expect(response.status).toBe(200);
        const responseBody: unknown = await response.json();
        assertNoCredential(responseBody);
        const completed = workflowRunResponseSchema.parse(responseBody);
        expect(completed.status).toBe('completed');
        const output = completed.outputs?.text;
        if (
          output?.storage !== 'inline' ||
          typeof output.value !== 'string' ||
          !output.value.trim()
        )
          throw new Error('真实模型未返回非空文本输出');
        const summary = {
          result: '真实文本 AI 端到端成功',
          runId: run.id,
          nodeRunId: nodes[0]?.id,
          model: configuration.model,
          text: output.value.slice(0, 512),
        };
        assertNoCredential(summary);
        console.info(JSON.stringify(summary));
      } catch {
        // 包括断言异常在内统一脱敏；不将 SDK / HTTP / Worker 原始文本交给 Vitest 输出。
        const summary = capabilityFailure
          ? ` ${capabilityFailure.code}${capabilityFailure.status ? ` HTTP ${capabilityFailure.status}` : ''}${capabilityFailure.outcome ? ` ${capabilityFailure.outcome}` : ''}`
          : '';
        throw new Error(
          `真实文本 AI 端到端验收失败${summary}；本测试不自动重试。`,
        );
      }
    },
    180000,
  );
});
