import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Type } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  StringType,
  productWorkflowInvocationResponseSchema,
  productWorkflowInvocationListSchema,
  workflowResponseSchema,
  workflowVersionResponseSchema,
  projectSchema,
  videoSchema,
  type StartWorkflowRunRequest,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  WorkflowRunSubmissionFactory,
  WorkflowOutboxDispatcher,
  WorkflowExecutionService,
  WorkflowCheckpointerService,
  StorageService,
  WorkflowExecutionQueue,
} from '@dramaflow/server';
import { NodeRegistry } from '@dramaflow/workflow';
import type { AuthService } from '../src/auth/auth.service.js';
import { authBaseUrl } from '../src/auth/trusted-origin.js';
import { ApiExceptionFilter } from '../src/http/exception.filter.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !== '/dramaflow_test' ||
  !process.env.WORKFLOW_QUEUE_PREFIX?.startsWith('dramaflow-test-')
)
  throw Error('产品调用集成测试仅允许隔离测试库与测试队列');
let app: NestExpressApplication;
let database: DatabaseService;
let base: string;
const users: string[] = [],
  cookies: string[] = [];
const origin = new URL(authBaseUrl()).origin;
const inputs = (value = '作品输入') => ({
  prompt: { storage: 'inline' as const, type: StringType, value },
});
const request = (versionId: string, key: string = randomUUID()): StartWorkflowRunRequest => ({
  workflowVersionId: versionId,
  invocationKey: key,
  inputs: inputs(),
});
async function api(path: string, method = 'GET', body?: unknown, actor = 0) {
  return fetch(`${base}/api/v1${path}`, {
    method,
    headers: { Cookie: cookies[actor] ?? '', Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const entry = (project: string, video: string) =>
  `/projects/${project}/videos/${video}/workflow-invocations`;
async function fixture(actor = 0) {
  const project = projectSchema.parse(
    await (await api('/projects', 'POST', { name: '产品调用项目' }, actor)).json(),
  );
  const workflow = workflowResponseSchema.parse(
    await (
      await api(`/projects/${project.id}/workflows`, 'POST', { name: '产品调用工作流' }, actor)
    ).json(),
  );
  const definition = {
    inputs: [{ name: 'prompt', type: StringType, required: true }],
    nodes: [
      {
        id: 'echo',
        type: 'test.product_echo',
        typeVersion: 1,
        name: '产物测试节点',
        inputs: { prompt: { type: 'workflow_input', key: 'prompt' } },
        config: {},
        ui: { position: { x: 0, y: 0 } },
      },
    ],
    edges: [],
    outputs: [{ name: 'text', type: StringType, source: { nodeId: 'echo', outputKey: 'text' } }],
  };
  expect(
    (
      await api(
        `/workflows/${workflow.id}/draft`,
        'PUT',
        { expectedRevision: workflow.revision, definition },
        actor,
      )
    ).status,
  ).toBe(200);
  const published = await api(
    `/workflows/${workflow.id}/publish`,
    'POST',
    { expectedRevision: workflow.revision + 1 },
    actor,
  );
  expect(published.status).toBe(201);
  const version = workflowVersionResponseSchema.parse(await published.json());
  const videos = [];
  for (const name of ['作品 A', '作品 B'])
    videos.push(
      videoSchema.parse(
        await (await api(`/projects/${project.id}/videos`, 'POST', { name }, actor)).json(),
      ),
    );
  return { project, workflow, version, videos, definition, path: entry(project.id, videos[0]!.id) };
}
async function accepted(path: string, body: StartWorkflowRunRequest) {
  const response = await api(path, 'POST', body);
  expect(response.status).toBe(202);
  return productWorkflowInvocationResponseSchema.parse(await response.json());
}
async function counts(projectId: string) {
  const db = database.client;
  return {
    invocations: await db.productWorkflowInvocation.count({ where: { projectId } }),
    runs: await db.workflowRun.count({ where: { projectId } }),
    outbox: await db.workflowExecutionOutbox.count({ where: { workflowRun: { projectId } } }),
  };
}

function registerEcho(registry: NodeRegistry) {
  // 仅测试装配的确定性节点，正式 Publish / Submission / Worker / 存储路径均不替换。
  registry.register({
    manifest: {
      type: 'test.product_echo',
      version: 1,
      executionKind: 'action',
      metadata: { name: '产品调用验证', category: 'data' },
      inputs: [{ key: 'prompt', name: '输入', dataType: StringType }],
      config: [],
      outputs: [{ key: 'text', name: '文本', dataType: StringType, storagePolicy: 'reference' }],
    },
    inputSchema: z.object({ prompt: z.string() }),
    configSchema: z.object({}).strict(),
    outputSchema: z.object({ text: z.string() }),
    async execute(input) {
      return { text: z.object({ prompt: z.string() }).parse(input).prompt };
    },
  });
}

beforeAll(async () => {
  const constructor = z.custom<Type<unknown>>((value) => typeof value === 'function');
  const module: unknown = await import(new URL('../dist/app.module.js', import.meta.url).href);
  const authModule: unknown = await import(
    new URL('../dist/auth/auth.service.js', import.meta.url).href
  );
  const { AppModule } = z.object({ AppModule: constructor }).parse(module);
  const { AuthService: AuthToken } = z.object({ AuthService: constructor }).parse(authModule);
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    abortOnError: false,
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  registerEcho(app.get(NodeRegistry));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  database = app.get(DatabaseService);
  const auth = app.get<AuthService>(AuthToken).auth;
  const password = randomBytes(24).toString('hex');
  for (const label of ['A', 'B']) {
    const email = `product-invocation-${randomUUID()}@example.test`;
    const { user } = await auth.api.createUser({
      body: { email, password, name: `产品调用 ${label}`, role: 'user' },
    });
    users.push(user.id);
    const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    cookies.push(
      response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    );
  }
}, 60000);

afterAll(async () => {
  vi.restoreAllMocks();
  try {
    if (database && users.length) {
      const db = database.client;
      const runs = await db.workflowRun.findMany({
        where: { project: { ownerId: { in: users } } },
      });
      const artifacts = await db.artifact.findMany({
        where: { project: { ownerId: { in: users } } },
      });
      for (const artifact of artifacts) await app.get(StorageService).delete(artifact.storageKey);
      for (const run of runs) {
        await app.get(WorkflowCheckpointerService).saver.deleteThread(run.threadId);
        await app.get(WorkflowExecutionQueue).remove({ kind: 'start', workflowRunId: run.id });
      }
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
  } finally {
    await app?.close();
  }
}, 60000);

describe('产品调用正式 HTTP 与持久化边界', () => {
  it('Publish 与删除并发时只可能保留已发布历史，或先删除尚未发布草稿', async () => {
    const f = await fixture();
    for (let index = 0; index < 4; index++) {
      const workflow = workflowResponseSchema.parse(
        await (
          await api(`/projects/${f.project.id}/workflows`, 'POST', { name: '发布与删除并发' })
        ).json(),
      );
      const [publish, remove] = await Promise.all([
        api(`/workflows/${workflow.id}/publish`, 'POST', { expectedRevision: 1 }),
        api(`/projects/${f.project.id}/workflows/${workflow.id}`, 'DELETE', {
          expectedRevision: 1,
          expectedMetadataRevision: 1,
        }),
      ]);
      if (publish.status === 201) {
        expect(remove.status).toBe(409);
        expect(
          await database.client.workflowVersion.count({ where: { workflowId: workflow.id } }),
        ).toBe(1);
        expect((await api(`/projects/${f.project.id}/workflows/${workflow.id}`)).status).toBe(200);
      } else {
        expect(remove.status).toBe(204);
        expect(publish.status).toBe(404);
        expect(
          await database.client.workflowVersion.count({ where: { workflowId: workflow.id } }),
        ).toBe(0);
      }
    }
  });
  it('同 Project 多 Workflow 独立 Draft / Version / 视口，同 Foundation key 不串联，产品 key 不改挂', async () => {
    const f = await fixture();
    const created = await api(`/projects/${f.project.id}/workflows`, 'POST', {
      name: 'Workflow B',
    });
    expect(created.status).toBe(201);
    const b = workflowResponseSchema.parse(await created.json());
    const definition = structuredClone(f.definition);
    definition.nodes[0]!.name = 'B 的独立草稿';
    expect(
      (await api(`/workflows/${b.id}/draft`, 'PUT', { expectedRevision: 1, definition })).status,
    ).toBe(200);
    const published = await api(`/workflows/${b.id}/publish`, 'POST', { expectedRevision: 2 });
    expect(published.status).toBe(201);
    const versionB = workflowVersionResponseSchema.parse(await published.json());
    expect(versionB).toMatchObject({
      workflowId: b.id,
      projectId: f.project.id,
      version: 1,
      sourceRevision: 2,
    });
    expect(versionB.id).not.toBe(f.version.id);
    expect(
      (await (await api(`/projects/${f.project.id}/workflows/${f.workflow.id}`)).json()).draft,
    ).toEqual(f.definition);
    expect(
      (
        await api(`/projects/${f.project.id}/workflows/${b.id}`, 'PUT', {
          expectedMetadataRevision: 1,
          name: '改名后的 B',
          viewport: { x: 40, y: -20, zoom: 1.5 },
        })
      ).status,
    ).toBe(200);
    const renamed = workflowResponseSchema.parse(
      await (await api(`/projects/${f.project.id}/workflows/${b.id}`)).json(),
    );
    expect(renamed).toMatchObject({
      name: '改名后的 B',
      revision: 2,
      metadataRevision: 2,
      viewport: { x: 40, y: -20, zoom: 1.5 },
      draft: definition,
    });
    expect(
      (await (await api(`/projects/${f.project.id}/workflows/${f.workflow.id}`)).json()).viewport,
    ).toEqual({ x: 0, y: 0, zoom: 1 });
    expect((await api(`/workflows/${b.id}/publish`, 'POST', { expectedRevision: 2 })).status).toBe(
      409,
    );
    expect(await (await api(`/workflow-versions/${versionB.id}`)).json()).toEqual(versionB);
    const sharedKey = randomUUID();
    const rootA = await api('/workflow-runs', 'POST', request(f.version.id, sharedKey));
    const rootB = await api('/workflow-runs', 'POST', request(versionB.id, sharedKey));
    expect(rootA.status).toBe(202);
    expect(rootB.status).toBe(202);
    const runA = await rootA.json(),
      runB = await rootB.json();
    expect(runA.id).not.toBe(runB.id);
    expect(runA.workflowId).toBe(f.workflow.id);
    expect(runB.workflowId).toBe(b.id);
    const productA = await accepted(f.path, request(f.version.id));
    const productB = await accepted(f.path, request(versionB.id));
    expect(productA.run.workflowId).toBe(f.workflow.id);
    expect(productB.run.workflowId).toBe(b.id);
    expect(productA.invocation.id).not.toBe(productB.invocation.id);
    // 产品 key 保持原有 Project 作用域，不能因选择 B 而重新解释 A 的调用。
    expect(
      (await api(f.path, 'POST', request(versionB.id, productA.invocation.invocationKey))).status,
    ).toBe(409);
    expect(
      (
        await api(
          entry(f.project.id, f.videos[1]!.id),
          'POST',
          request(versionB.id, productA.invocation.invocationKey),
        )
      ).status,
    ).toBe(409);
    expect(await counts(f.project.id)).toEqual({ invocations: 2, runs: 4, outbox: 4 });
    const blocked = await api(`/projects/${f.project.id}/workflows/${b.id}`, 'DELETE', {
      expectedRevision: 2,
      expectedMetadataRevision: 2,
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).code).toBe('WORKFLOW_HAS_HISTORY');
    const empty = workflowResponseSchema.parse(
      await (
        await api(`/projects/${f.project.id}/workflows`, 'POST', { name: '未发布草稿' })
      ).json(),
    );
    expect(
      (
        await api(`/projects/${f.project.id}/workflows/${empty.id}`, 'DELETE', {
          expectedRevision: 1,
          expectedMetadataRevision: 1,
        })
      ).status,
    ).toBe(204);
    expect((await api(`/projects/${f.project.id}/workflows/${empty.id}`)).status).toBe(404);
  });

  it('集合与 Workflow 身份读写、删除限定 Project / owner，重名分页仍保留独立身份', async () => {
    const f = await fixture(),
      other = await fixture();
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const payload =
        method === 'GET'
          ? undefined
          : method === 'PUT'
            ? { name: '越权改名', expectedMetadataRevision: 1 }
            : { expectedRevision: 2, expectedMetadataRevision: 1 };
      expect(
        (await api(`/projects/${other.project.id}/workflows/${f.workflow.id}`, method, payload))
          .status,
      ).toBe(404);
      expect(
        (await api(`/projects/${f.project.id}/workflows/${f.workflow.id}`, method, payload, 1))
          .status,
      ).toBe(404);
    }
    expect((await api(`/projects/${f.project.id}/workflows`, 'GET', undefined, 1)).status).toBe(
      404,
    );
    expect((await api(`/projects/${randomUUID()}/workflows`)).status).toBe(404);
    expect((await api(`/projects/${f.project.id}/workflows?cursor=bad`)).status).toBe(400);
    for (let index = 0; index < 31; index++)
      expect(
        (await api(`/projects/${f.project.id}/workflows`, 'POST', { name: '相同名称' })).status,
      ).toBe(201);
    await database.client.workflow.updateMany({
      where: { projectId: f.project.id },
      data: { createdAt: new Date('2026-10-30T00:00:00.000Z') },
    });
    const first = await (await api(`/projects/${f.project.id}/workflows`)).json();
    const second = await (
      await api(`/projects/${f.project.id}/workflows?cursor=${first.nextCursor}`)
    ).json();
    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(2);
    expect(
      new Set([...first.items, ...second.items].map((item: { id: string }) => item.id)).size,
    ).toBe(32);
    expect(second.nextCursor).toBeNull();
    expect(
      (
        await api(`/projects/${f.project.id}/workflows/${f.workflow.id}`, 'PUT', {
          expectedMetadataRevision: 9,
          name: '过期改名',
        })
      ).status,
    ).toBe(409);
  });

  it('Video 正常发起：Invocation、Run、start Outbox 同时存在且没有复制运行事实', async () => {
    const f = await fixture();
    const dispatcher = app.get(WorkflowOutboxDispatcher);
    const dispatch = dispatcher.publishStart.bind(dispatcher);
    const publish = vi.spyOn(dispatcher, 'publishStart').mockImplementation(async (id) => {
      // 使用事务外连接观察：真正调用 dispatcher 前，三条记录必须已经一起提交。
      expect(
        await database.client.productWorkflowInvocation.count({ where: { workflowRunId: id } }),
      ).toBe(1);
      expect(await counts(f.project.id)).toEqual({ invocations: 1, runs: 1, outbox: 1 });
      await dispatch(id);
    });
    const body = request(f.version.id);
    const result = await accepted(f.path, body);
    publish.mockRestore();
    expect(result.invocation).toMatchObject({
      projectId: f.project.id,
      sourceVideoId: f.videos[0]!.id,
      sourceVideoName: '作品 A',
      workflowRunId: result.run.id,
      invocationKey: result.run.invocationKey,
    });
    expect(result.run).toMatchObject({
      workflowId: f.workflow.id,
      workflowVersionId: f.version.id,
      status: 'pending',
      inputs: inputs(),
    });
    expect(await counts(f.project.id)).toEqual({ invocations: 1, runs: 1, outbox: 1 });
    expect(Object.keys(result.invocation).sort()).toEqual(
      [
        'id',
        'projectId',
        'sourceVideoId',
        'sourceVideoName',
        'workflowRunId',
        'invocationKey',
        'createdAt',
      ].sort(),
    );
    expect(
      (
        await database.client.workflowExecutionOutbox.findFirstOrThrow({
          where: { workflowRunId: result.run.id },
        })
      ).status,
    ).toBe('published');
    expect(
      (
        await api(`/projects/${f.project.id}/videos/${f.videos[0]!.id}`, 'PUT', {
          name: '改名后的作品',
          status: 'active',
          revision: 1,
        })
      ).status,
    ).toBe(200);
    expect((await accepted(f.path, body)).invocation).toEqual(result.invocation);
  });
  it('产品记录失败或事务提交前故障时，Run 与 Outbox 一并回滚', async () => {
    const f = await fixture(),
      factory = app.get(WorkflowRunSubmissionFactory);
    for (const failSource of [true, false]) {
      await expect(
        factory.inProjectStartTransaction(users[0]!, f.project.id, async (tx, start) => {
          const { run } = await start({
            ...request(f.version.id),
            projectId: f.project.id,
            workflowId: f.workflow.id,
          });
          await tx.productWorkflowInvocation.create({
            data: {
              projectId: f.project.id,
              sourceVideoId: failSource ? randomUUID() : f.videos[0]!.id,
              sourceVideoName: '作品 A',
              workflowRunId: run.id,
              invocationKey: run.invocationKey,
            },
          });
          throw Error('测试在提交前中断受理');
        }),
      ).rejects.toThrow();
      expect(await counts(f.project.id)).toEqual({ invocations: 0, runs: 0, outbox: 0 });
    }
  });
  it('同 Video 同 key 并发和重试复用同一 Invocation / Run / Outbox', async () => {
    const f = await fixture(),
      body = request(f.version.id);
    const results = await Promise.all(Array.from({ length: 8 }, () => accepted(f.path, body)));
    expect(new Set(results.map((result) => result.invocation.id)).size).toBe(1);
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
    expect(await counts(f.project.id)).toEqual({ invocations: 1, runs: 1, outbox: 1 });
  });
  it('同 key 不同 Video 并发只能受理一个来源，不能改挂', async () => {
    const f = await fixture(),
      body = request(f.version.id);
    const responses = await Promise.all(
      f.videos.map((video) => api(entry(f.project.id, video.id), 'POST', body)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    const winner = productWorkflowInvocationResponseSchema.parse(
      await responses.find((response) => response.status === 202)!.json(),
    );
    const conflict = await responses.find((response) => response.status === 409)!.json();
    expect(conflict.code).toBe('PRODUCT_WORKFLOW_INVOCATION_CONFLICT');
    expect(await counts(f.project.id)).toEqual({ invocations: 1, runs: 1, outbox: 1 });
    expect(
      (
        await database.client.productWorkflowInvocation.findUniqueOrThrow({
          where: { id: winner.invocation.id },
        })
      ).sourceVideoId,
    ).toBe(winner.invocation.sourceVideoId);
  });
  it('inputs / version 不等价由正式 Submission 拒绝，既有来源不变', async () => {
    const f = await fixture(),
      body = request(f.version.id);
    const original = await accepted(f.path, body);
    expect((await api(f.path, 'POST', { ...body, inputs: inputs('不同输入') })).status).toBe(409);
    expect(
      (
        await api(`/workflows/${f.workflow.id}/draft`, 'PUT', {
          expectedRevision: 2,
          definition: f.definition,
        })
      ).status,
    ).toBe(200);
    const newer = workflowVersionResponseSchema.parse(
      await (
        await api(`/workflows/${f.workflow.id}/publish`, 'POST', { expectedRevision: 3 })
      ).json(),
    );
    expect((await api(f.path, 'POST', { ...body, workflowVersionId: newer.id })).status).toBe(409);
    expect(await counts(f.project.id)).toEqual({ invocations: 1, runs: 1, outbox: 1 });
    expect(
      (
        await database.client.productWorkflowInvocation.findUniqueOrThrow({
          where: { id: original.invocation.id },
        })
      ).workflowRunId,
    ).toBe(original.run.id);
  });
  it('跨 Project Video / Version、其他账号、无登录、无效或不存在身份均不能受理', async () => {
    const a = await fixture(),
      b = await fixture(),
      foreign = await fixture(1);
    for (const [path, body, actor] of [
      [a.path, request(b.version.id), 0],
      [entry(b.project.id, a.videos[0]!.id), request(b.version.id), 0],
      [a.path, request(foreign.version.id), 0],
      [a.path, request(a.version.id), 1],
      [entry(a.project.id, randomUUID()), request(a.version.id), 0],
      [a.path, request('missing-version'), 0],
      [a.path, request(a.workflow.id), 0],
    ] as const)
      expect((await api(path, 'POST', body, actor)).status).toBe(404);
    expect((await api(a.path, 'POST', request(a.version.id), 99)).status).toBe(401);
    expect(
      (await api(entry('invalid', a.videos[0]!.id), 'POST', request(a.version.id))).status,
    ).toBe(400);
    expect((await api(a.path, 'POST', { ...request(a.version.id), inputs: {} })).status).toBe(400);
    expect(
      (await api(a.path, 'POST', { ...request(a.version.id), workflowVersionId: '' })).status,
    ).toBe(400);
    const invalid = await database.client.workflowVersion.create({
      data: { workflowId: a.workflow.id, version: 2, sourceRevision: 99, definition: {} },
    });
    expect((await api(a.path, 'POST', request(invalid.id))).status).toBe(500);
    for (const f of [a, b, foreign])
      expect(await counts(f.project.id)).toEqual({ invocations: 0, runs: 0, outbox: 0 });
  });
  it('dispatch 结果不明保留全部已受理身份；产品 lookup / 历史只查询，不再次提交', async () => {
    const f = await fixture(),
      body = request(f.version.id);
    const dispatcher = app.get(WorkflowOutboxDispatcher);
    const publish = vi
      .spyOn(dispatcher, 'publishStart')
      .mockRejectedValueOnce(Error('测试投递确认丢失'));
    const response = await api(f.path, 'POST', body);
    expect(response.status).toBe(503);
    const failure = await response.json();
    expect(failure).toMatchObject({
      code: 'WORKFLOW_QUEUE_UNAVAILABLE',
      invocationKey: body.invocationKey,
      workflowRunId: expect.any(String),
      productWorkflowInvocationId: expect.any(String),
    });
    const lookup = await api(
      `/projects/${f.project.id}/workflow-invocations/by-key/${body.invocationKey}`,
    );
    const recovered = (await lookup.json()).invocation;
    expect(recovered).toMatchObject({
      id: failure.productWorkflowInvocationId,
      workflowRunId: failure.workflowRunId,
      sourceVideoId: f.videos[0]!.id,
    });
    const history = productWorkflowInvocationListSchema.parse(await (await api(f.path)).json());
    expect(history.items).toHaveLength(1);
    expect(
      (await (await api(`/projects/${f.project.id}/workflow-invocations/${recovered.id}`)).json())
        .run.id,
    ).toBe(failure.workflowRunId);
    expect(publish).toHaveBeenCalledTimes(1);
    publish.mockRestore();
    expect((await accepted(f.path, body)).invocation.id).toBe(recovered.id);
  });
  it('产品查询保持 Project / Owner 隔离，非法来源列表不返回空成功', async () => {
    const f = await fixture(),
      other = await fixture();
    const original = await accepted(f.path, request(f.version.id));
    expect(
      (await api(`/projects/${other.project.id}/workflow-invocations/${original.invocation.id}`))
        .status,
    ).toBe(404);
    expect(
      (
        await api(
          `/projects/${f.project.id}/workflow-invocations/${original.invocation.id}`,
          'GET',
          undefined,
          1,
        )
      ).status,
    ).toBe(404);
    expect((await api(entry(f.project.id, other.videos[0]!.id))).status).toBe(404);
    expect((await api(`${f.path}?cursor=invalid`)).status).toBe(400);
    expect(
      (
        await (
          await api(
            `/projects/${other.project.id}/workflow-invocations/by-key/${original.invocation.invocationKey}`,
          )
        ).json()
      ).invocation,
    ).toBeNull();
  });
  it('Canvas 普通 Run 不创建产品调用，也不能用同 key 被 Video 认领；原取消和 Tree 入口仍有效', async () => {
    const f = await fixture(),
      body = request(f.version.id);
    const response = await api('/workflow-runs', 'POST', body);
    expect(response.status).toBe(202);
    const run = await response.json();
    expect(
      await database.client.productWorkflowInvocation.count({ where: { projectId: f.project.id } }),
    ).toBe(0);
    expect((await api(f.path, 'POST', body)).status).toBe(409);
    expect((await api(`/workflow-runs/${run.id}/execution-tree`)).status).toBe(200);
    expect(
      (
        await api(
          `/projects/${f.project.id}/workflows/${f.workflow.id}/runs/${run.id}/cancel`,
          'POST',
          {},
        )
      ).status,
    ).toBe(200);
    expect((await (await api(`/workflow-runs/${run.id}`)).json()).status).toBe('cancelled');
  });
  it('真实队列执行产出 Artifact；Video 永久删除后来源、Run、Artifact、Tree 均保留', async () => {
    const f = await fixture();
    const original = await accepted(f.path, request(f.version.id));
    const queue = app.get(WorkflowExecutionQueue).queue;
    await queue.pause();
    const module: unknown = await import(
      new URL('../../worker/dist/app.module.js', import.meta.url).href
    );
    const token = z
      .object({ AppModule: z.custom<Type<unknown>>((value) => typeof value === 'function') })
      .parse(module).AppModule;
    const worker = await NestFactory.createApplicationContext(token, {
      logger: false,
      abortOnError: false,
    });
    try {
      registerEcho(worker.get(NodeRegistry));
      expect(worker.get(WorkflowExecutionService)).toBeInstanceOf(WorkflowExecutionService);
      await queue.resume();
      await vi.waitFor(
        async () =>
          expect(
            (
              await database.client.workflowRun.findUniqueOrThrow({
                where: { id: original.run.id },
              })
            ).status,
          ).toBe('completed'),
        { timeout: 20000 },
      );
    } finally {
      await queue.pause();
      await worker.close();
      await queue.resume();
    }
    const artifact = await database.client.artifact.findFirstOrThrow({
      where: { workflowRunId: original.run.id },
    });
    expect(artifact.nodeRunId).not.toBeNull();
    expect(artifact.status).toBe('ready');
    expect((await app.get(StorageService).get(artifact.storageKey)).length).toBeGreaterThan(0);
    expect(
      (await api(`/projects/${f.project.id}/videos/${f.videos[0]!.id}`, 'DELETE')).status,
    ).toBe(204);
    expect((await api(f.path, 'POST', request(f.version.id))).status).toBe(404);
    expect((await api(f.path)).status).toBe(200);
    const history = await api(
      `/projects/${f.project.id}/workflow-invocations/${original.invocation.id}`,
    );
    expect((await history.json()).invocation).toEqual(original.invocation);
    expect((await api(`/workflow-runs/${original.run.id}/execution-tree`)).status).toBe(200);
    expect(
      await database.client.artifact.findUnique({ where: { id: artifact.id } }),
    ).not.toBeNull();
    const blockedDeletion = await api(
      `/projects/${f.project.id}/workflows/${f.workflow.id}`,
      'DELETE',
      { expectedRevision: 2, expectedMetadataRevision: 1 },
    );
    expect(blockedDeletion.status).toBe(409);
    expect(
      await database.client.artifact.findUnique({ where: { id: artifact.id } }),
    ).not.toBeNull();
    expect(
      (await api(`/projects/${f.project.id}/workflow-invocations/${original.invocation.id}`))
        .status,
    ).toBe(200);
    const productRun = await database.client.workflowRun.findUniqueOrThrow({
      where: { id: original.run.id },
    });
    await app.get(WorkflowCheckpointerService).saver.deleteThread(productRun.threadId);
    await app.get(WorkflowExecutionQueue).remove({ kind: 'start', workflowRunId: productRun.id });
    // 正式项目删除继续清理 Run、Artifact、checkpoint、Job 与产品来源记录。
    expect((await api(`/projects/${f.project.id}`, 'DELETE')).status).toBe(204);
    expect(
      await database.client.productWorkflowInvocation.findUnique({
        where: { id: original.invocation.id },
      }),
    ).toBeNull();
    expect(
      await database.client.workflowRun.findUnique({ where: { id: original.run.id } }),
    ).toBeNull();
  }, 30000);
});
