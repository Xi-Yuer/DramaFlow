import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  projectSchema,
  StringType,
  workflowResponseSchema,
  workflowVersionResponseSchema,
  workflowVersionListResponseSchema,
  NumberType,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  ModelProviderService,
  SecretsService,
} from '@dramaflow/server';
import {
  createTextGenerationNodeType,
  NodeRegistry,
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
import { createWorkflowService } from './fixtures/workflow-service.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test' ||
  !process.env.WORKFLOW_QUEUE_PREFIX?.startsWith('dramaflow-test-')
)
  throw new Error('Workflow 编辑 HTTP 测试仅允许隔离测试库与队列');

const database = new DatabaseService();
const db = database.client;
const applications: Awaited<ReturnType<typeof application>>[] = [];
const userIds: string[] = [];
const cookies: string[] = [];
const origin = new URL(authBaseUrl()).origin;
const emptyDraft = { inputs: [], nodes: [], edges: [], outputs: [] };

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

beforeAll(async () => {
  applications.push(await application());
  applications.push(await application());
  const password = randomBytes(24).toString('hex');
  for (const name of ['A', 'B']) {
    const auth = applications[0]!.auth.auth;
    const email = `workflow-editor-${randomUUID()}@example.test`;
    const { user } = await auth.api.createUser({
      body: { email, name: `工作流编辑 ${name}`, password, role: 'user' },
    });
    userIds.push(user.id);
    const response = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(cookie).not.toBe('');
    cookies.push(cookie);
  }
});

async function textPublication() {
  const project = await createProject('正式发布测试');
  const workflow = await readWorkflow(project.id);
  const models = applications[0]!.app.get(ModelProviderService);
  const provider = await models.createProvider(userIds[0]!, {
    projectId: project.id,
    name: '明确选择的离线测试服务',
    pluginId: 'openai_compatible',
    pluginVersion: 1,
    configuration: { baseURL: 'http://127.0.0.1:1/v1' },
    credentials: { apiKey: 'test-publish-secret-marker' },
  });
  const model = await models.createModelConfiguration(userIds[0]!, {
    projectId: project.id,
    providerId: provider.id,
    capability: 'text.generate',
    model: 'explicit-test-model',
    settings: {},
  });
  const draft = definition('正式发布内容');
  draft.nodes[0]!.config = { modelConfigurationId: model.id };
  return { project, workflow, models, provider, model, draft };
}

describe('正式 Publish 边界与版本 HTTP', () => {
  it('合法正式文本定义发布、读取完整快照和版本列表；发布不探活、不解密或创建 Run', async () => {
    const f = await textPublication();
    const decrypt = vi.spyOn(SecretsService.prototype, 'decrypt');
    try {
      expect(
        (
          await api(`/workflows/${f.workflow.id}/draft`, 'PUT', {
            expectedRevision: 1,
            definition: f.draft,
          })
        ).status,
      ).toBe(200);
      const response = await api(
        `/workflows/${f.workflow.id}/publish`,
        'POST',
        { expectedRevision: 2 },
      );
      expect(response.status).toBe(201);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const version = workflowVersionResponseSchema.parse(
        await response.json(),
      );
      expect(version).toMatchObject({
        workflowId: f.workflow.id,
        projectId: f.project.id,
        version: 1,
        sourceRevision: 2,
        definition: f.draft,
      });
      expect(await readWorkflow(f.project.id)).toMatchObject({
        revision: 2,
        draft: f.draft,
      });
      const read = await api(
        `/workflow-versions/${version.id}`,
        'GET',
        undefined,
        0,
        1,
      );
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(version);
      const listed = await api(`/workflows/${f.workflow.id}/versions`);
      expect(listed.status).toBe(200);
      const list = workflowVersionListResponseSchema.parse(await listed.json());
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).not.toHaveProperty('definition');
      expect(list.nextBeforeVersion).toBeNull();
      expect(decrypt).not.toHaveBeenCalled();
      const text = JSON.stringify({ version, list });
      for (const privateValue of [
        'test-publish-secret-marker',
        '127.0.0.1:1',
        'encryptedCredentials',
        'explicit-test-model',
      ])
        expect(text).not.toContain(privateValue);
      expect(
        await db.workflowRun.count({ where: { projectId: f.project.id } }),
      ).toBe(0);
    } finally {
      decrypt.mockRestore();
    }
  });

  it('Draft 允许不完整和不可执行内容，Publish 逐项拒绝，失败不消耗版本或修改草稿', async () => {
    const f = await textPublication();
    const cases: [string, (draft: WorkflowDefinition) => void][] = [
      [
        'NODE_TYPE_UNAVAILABLE',
        (g) => {
          g.nodes[0]!.type = 'missing.node';
        },
      ],
      [
        'NODE_TYPE_UNAVAILABLE',
        (g) => {
          g.nodes[0]!.typeVersion = 99;
        },
      ],
      [
        'INPUT_SOURCE_MISSING',
        (g) => {
          g.nodes[0]!.inputs = {};
        },
      ],
      [
        'INPUT_PORT_NOT_FOUND',
        (g) => {
          g.nodes[0]!.inputs.extra = { type: 'constant', value: 'extra' };
        },
      ],
      [
        'INPUT_VALUE_INVALID',
        (g) => {
          g.nodes[0]!.inputs.prompt = { type: 'constant', value: '' };
        },
      ],
      [
        'INPUT_TYPE_MISMATCH',
        (g) => {
          g.inputs = [{ name: 'prompt', type: NumberType }];
          g.nodes[0]!.inputs.prompt = { type: 'workflow_input', key: 'prompt' };
        },
      ],
      [
        'OUTPUT_PORT_NOT_FOUND',
        (g) => {
          g.outputs[0]!.source.outputKey = 'missing';
        },
      ],
      [
        'WORKFLOW_OUTPUT_TYPE_MISMATCH',
        (g) => {
          g.outputs[0]!.type = NumberType;
        },
      ],
      [
        'ASSET_BINDING_UNSUPPORTED',
        (g) => {
          g.nodes[0]!.inputs.prompt = {
            type: 'asset',
            assetId: 'asset',
            versionId: 'v1',
          };
        },
      ],
      [
        'NODE_CONFIG_INVALID',
        (g) => {
          g.nodes[0]!.config = {};
        },
      ],
    ];
    let revision = 1;
    for (const [code, mutate] of cases) {
      const draft = structuredClone(f.draft);
      mutate(draft);
      const saved = await api(`/workflows/${f.workflow.id}/draft`, 'PUT', {
        expectedRevision: revision,
        definition: draft,
      });
      expect(saved.status).toBe(200);
      revision++;
      const before = await readWorkflow(f.project.id);
      const response = await api(
        `/workflows/${f.workflow.id}/publish`,
        'POST',
        { expectedRevision: revision },
      );
      expect(response.status).toBe(400);
      const error = await response.json();
      if (code === 'NODE_CONFIG_INVALID')
        expect(error.code).toBe('WORKFLOW_NODE_CONFIGURATION_INVALID');
      else
        expect(error.details).toContainEqual(expect.objectContaining({ code }));
      expect(
        await db.workflowVersion.count({
          where: { workflowId: f.workflow.id },
        }),
      ).toBe(0);
      expect(await readWorkflow(f.project.id)).toEqual(before);
    }
    // 直接存储的未可信定义也必须经过发布边界重新验证。
    const corrupt = structuredClone(f.draft);
    corrupt.outputs[0]!.source.nodeId = 'missing';
    await db.workflow.update({
      where: { id: f.workflow.id },
      data: { draft: z.record(z.string(), z.json()).parse(corrupt) },
    });
    expect(
      (
        await api(`/workflows/${f.workflow.id}/publish`, 'POST', {
          expectedRevision: revision,
        })
      ).status,
    ).toBe(400);
    const unsafe = structuredClone(f.draft);
    unsafe.nodes[0]!.config.apiKey = 'secret-in-untrusted-draft';
    await db.workflow.update({
      where: { id: f.workflow.id },
      data: { draft: z.record(z.string(), z.json()).parse(unsafe) },
    });
    const rejected = await api(`/workflows/${f.workflow.id}/publish`, 'POST', {
      expectedRevision: revision,
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain('secret-in-untrusted-draft');
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(0);
    await api(`/workflows/${f.workflow.id}/draft`, 'PUT', {
      expectedRevision: revision,
      definition: f.draft,
    });
    const published = await api(`/workflows/${f.workflow.id}/publish`, 'POST', {
      expectedRevision: revision + 1,
    });
    expect(published.status).toBe(201);
    expect(await published.json()).toMatchObject({
      version: 1,
      sourceRevision: revision + 1,
    });
  });

  it('Data Edge 的两端端口及命名 Control Edge 在 HTTP 发布边界拒绝', async () => {
    const f = await textPublication();
    const first = structuredClone(f.draft.nodes[0]!);
    first.id = 'first';
    f.draft.nodes.push(first);
    f.draft.nodes[0]!.inputs = {};
    f.draft.edges = [
      {
        id: 'link',
        kind: 'data',
        source: { nodeId: 'first', portKey: 'text' },
        target: { nodeId: 'text', portKey: 'prompt' },
      },
    ];
    let revision = 1;
    for (const mode of ['source', 'target', 'control']) {
      const draft = structuredClone(f.draft);
      if (mode === 'source') draft.edges[0]!.source.portKey = 'wrong';
      if (mode === 'target') draft.edges[0]!.target.portKey = 'wrong';
      if (mode === 'control')
        draft.edges.push({
          id: 'control',
          kind: 'control',
          source: { nodeId: 'first', portKey: 'approved' },
          target: { nodeId: 'text' },
        });
      expect(
        (
          await api(`/workflows/${f.workflow.id}/draft`, 'PUT', {
            expectedRevision: revision++,
            definition: draft,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await api(`/workflows/${f.workflow.id}/publish`, 'POST', {
            expectedRevision: revision,
          })
        ).status,
      ).toBe(400);
      expect(
        await db.workflowVersion.count({
          where: { workflowId: f.workflow.id },
        }),
      ).toBe(0);
    }
  });

  it('缺失、跨项目、跨所有者、停用和能力不匹配的模型配置均拒绝，不泄漏 Provider 信息', async () => {
    const f = await textPublication();
    const other = await textPublication();
    const incompatible = await db.modelConfiguration.create({
      data: {
        projectId: f.project.id,
        providerId: f.provider.id,
        capability: 'image.generate',
        model: 'incompatible',
        settings: {},
      },
    });
    for (const id of [randomUUID(), other.model.id, incompatible.id]) {
      const draft = structuredClone(f.draft);
      draft.nodes[0]!.config.modelConfigurationId = id;
      await db.workflow.update({
        where: { id: f.workflow.id },
        data: { draft: z.record(z.string(), z.json()).parse(draft) },
      });
      const response = await api(
        `/workflows/${f.workflow.id}/publish`,
        'POST',
        { expectedRevision: 1 },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'MODEL_CONFIGURATION_UNAVAILABLE',
      });
    }
    await db.project.update({
      where: { id: other.project.id },
      data: { ownerId: userIds[1] },
    });
    f.draft.nodes[0]!.config.modelConfigurationId = other.model.id;
    await db.workflow.update({
      where: { id: f.workflow.id },
      data: { draft: z.record(z.string(), z.json()).parse(f.draft) },
    });
    expect(
      (
        await api(`/workflows/${f.workflow.id}/publish`, 'POST', {
          expectedRevision: 1,
        })
      ).status,
    ).toBe(400);
    f.draft.nodes[0]!.config.modelConfigurationId = f.model.id;
    await db.workflow.update({
      where: { id: f.workflow.id },
      data: { draft: z.record(z.string(), z.json()).parse(f.draft) },
    });
    await db.modelConfiguration.update({
      where: { id: f.model.id },
      data: { enabled: false },
    });
    expect(
      (
        await api(`/workflows/${f.workflow.id}/publish`, 'POST', {
          expectedRevision: 1,
        })
      ).status,
    ).toBe(400);
    await db.modelConfiguration.update({
      where: { id: f.model.id },
      data: { enabled: true },
    });
    await db.modelProvider.update({
      where: { id: f.provider.id },
      data: { enabled: false },
    });
    expect(
      (
        await api(`/workflows/${f.workflow.id}/publish`, 'POST', {
          expectedRevision: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(0);
  });

  it('未注册插件、插件不提供该能力、无效 endpoint 或参数不能发布', async () => {
    const f = await textPublication();
    for (const mode of [
      'missing_plugin',
      'missing_plugin_version',
      'invalid_endpoint',
      'invalid_settings',
    ]) {
      const provider = await db.modelProvider.create({
        data: {
          projectId: f.project.id,
          name: '不可信导入配置',
          pluginId:
            mode === 'missing_plugin' ? 'missing_plugin' : 'openai_compatible',
          pluginVersion: mode === 'missing_plugin_version' ? 99 : 1,
          configuration: {
            baseURL:
              mode === 'invalid_endpoint' ? 'invalid' : 'http://127.0.0.1:1/v1',
          },
          encryptedCredentials: 'not-read-during-publish',
        },
      });
      const model = await db.modelConfiguration.create({
        data: {
          projectId: f.project.id,
          providerId: provider.id,
          capability: 'text.generate',
          model: 'explicit-model',
          settings: mode === 'invalid_settings' ? { temperature: 100 } : {},
        },
      });
      const draft = structuredClone(f.draft);
      draft.nodes[0]!.config.modelConfigurationId = model.id;
      await db.workflow.update({
        where: { id: f.workflow.id },
        data: { draft: z.record(z.string(), z.json()).parse(draft) },
      });
      const response = await api(
        `/workflows/${f.workflow.id}/publish`,
        'POST',
        { expectedRevision: 1 },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'MODEL_CONFIGURATION_INVALID',
      });
      expect(
        await db.workflowVersion.count({
          where: { workflowId: f.workflow.id },
        }),
      ).toBe(0);
    }
  });

  it('stale revision 和 12 次跨 API 并发发布保持原语义，后续 Draft / 停用 / 凭证轮换不改旧版本', async () => {
    const f = await textPublication();
    await api(`/workflows/${f.workflow.id}/draft`, 'PUT', {
      expectedRevision: 1,
      definition: f.draft,
    });
    expect(
      (
        await api(`/workflows/${f.workflow.id}/publish`, 'POST', {
          expectedRevision: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(0);
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api(
          `/workflows/${f.workflow.id}/publish`,
          'POST',
          { expectedRevision: 2 },
          0,
          i % 2,
        ),
      ),
    );
    expect(responses.filter(({ status }) => status === 201)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 409)).toHaveLength(11);
    const version = workflowVersionResponseSchema.parse(
      await responses.find(({ status }) => status === 201)!.json(),
    );
    for (const response of responses.filter(({ status }) => status === 409))
      expect(await response.json()).toMatchObject({
        code: 'WORKFLOW_REVISION_ALREADY_PUBLISHED',
      });
    await api(`/workflows/${f.workflow.id}/draft`, 'PUT', {
      expectedRevision: 2,
      definition: f.draft,
    });
    await f.models.replaceCredentials(
      userIds[0]!,
      f.project.id,
      f.provider.id,
      { apiKey: 'rotated-test-credential' },
    );
    await db.modelProvider.update({
      where: { id: f.provider.id },
      data: { enabled: false },
    });
    expect(
      (
        await api(`/workflows/${f.workflow.id}/publish`, 'POST', {
          expectedRevision: 3,
        })
      ).status,
    ).toBe(400);
    const old = await api(`/workflow-versions/${version.id}`);
    expect(await old.json()).toEqual(version);
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(1);
    expect(await readWorkflow(f.project.id)).toMatchObject({ revision: 3 });
  });

  it('并发停用配置时发布等待配置行锁，读取提交后的停用状态后拒绝', async () => {
    const f = await textPublication();
    await api(`/workflows/${f.workflow.id}/draft`, 'PUT', {
      expectedRevision: 1,
      definition: f.draft,
    });
    let release!: () => void;
    let locked!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<number>((resolve) => {
      locked = resolve;
    });
    const disabling = db.$transaction(
      async (tx) => {
        const [connection] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        await tx.modelConfiguration.update({
          where: { id: f.model.id },
          data: { enabled: false },
        });
        locked(connection!.pid);
        await gate;
      },
      { timeout: 15000 },
    );
    const pid = await ready;
    const publishing = api(`/workflows/${f.workflow.id}/publish`, 'POST', {
      expectedRevision: 2,
    });
    try {
      await vi.waitFor(async () => {
        const [result] = await db.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS waiting`;
        expect(result?.waiting).toBe(true);
      });
    } finally {
      release();
      await disabling;
    }
    expect((await publishing).status).toBe(400);
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(0);
  });

  it('发布与版本查询默认认证、隔离所有者并检查写 Origin；严格拒绝客户端定义覆盖', async () => {
    const project = await createProject();
    const workflow = await readWorkflow(project.id);
    const published = await api(`/workflows/${workflow.id}/publish`, 'POST', {
      expectedRevision: 1,
    });
    const version = workflowVersionResponseSchema.parse(await published.json());
    for (const [path, method, body] of [
      [`/workflows/${workflow.id}/publish`, 'POST', { expectedRevision: 1 }],
      [`/workflows/${workflow.id}/versions`, 'GET', undefined],
      [`/workflow-versions/${version.id}`, 'GET', undefined],
    ] as const) {
      expect((await api(path, method, body, null)).status).toBe(401);
      expect((await api(path, method, body, 1)).status).toBe(404);
    }
    expect(
      (
        await api(
          `/workflows/${workflow.id}/publish`,
          'POST',
          { expectedRevision: 1 },
          0,
          0,
          'https://untrusted.invalid',
        )
      ).status,
    ).toBe(403);
    for (const body of [
      {},
      { expectedRevision: '1' },
      { expectedRevision: 1, definition: emptyDraft },
      { expectedRevision: 1, ownerId: userIds[1] },
    ])
      expect(
        (await api(`/workflows/${workflow.id}/publish`, 'POST', body)).status,
      ).toBe(400);
    expect(
      (
        await api(`/workflows/${randomUUID()}/publish`, 'POST', {
          expectedRevision: 1,
        })
      ).status,
    ).toBe(404);
    expect((await api(`/workflow-versions/${randomUUID()}`)).status).toBe(404);
    expect((await api(`/workflows/${randomUUID()}/versions`)).status).toBe(404);
    expect(
      (await api(`/workflows/${workflow.id}/versions?beforeVersion=invalid`))
        .status,
    ).toBe(400);
    await db.project.update({
      where: { id: project.id },
      data: { ownerId: userIds[1] },
    });
    expect((await api(`/workflow-versions/${version.id}`)).status).toBe(404);
    expect((await api(`/workflows/${workflow.id}/versions`)).status).toBe(404);
  });

  it('版本列表按 version 倒序有界分页，空列表不产生版本', async () => {
    const project = await createProject();
    const workflow = await readWorkflow(project.id);
    const empty = await api(`/workflows/${workflow.id}/versions`);
    expect(await empty.json()).toEqual({ items: [], nextBeforeVersion: null });
    for (let revision = 1; revision <= 22; revision++) {
      if (revision > 1)
        expect(
          (
            await api(`/workflows/${workflow.id}/draft`, 'PUT', {
              expectedRevision: revision - 1,
              definition: emptyDraft,
            })
          ).status,
        ).toBe(200);
      expect(
        (
          await api(`/workflows/${workflow.id}/publish`, 'POST', {
            expectedRevision: revision,
          })
        ).status,
      ).toBe(201);
    }
    const first = workflowVersionListResponseSchema.parse(
      await (await api(`/workflows/${workflow.id}/versions`)).json(),
    );
    expect(first.items.map(({ version }) => version)).toEqual(
      Array.from({ length: 20 }, (_, i) => 22 - i),
    );
    expect(first.nextBeforeVersion).toBe(3);
    const second = workflowVersionListResponseSchema.parse(
      await (
        await api(`/workflows/${workflow.id}/versions?beforeVersion=3`)
      ).json(),
    );
    expect(second.items.map(({ version }) => version)).toEqual([2, 1]);
    expect(second.nextBeforeVersion).toBeNull();
  });
});

afterAll(async () => {
  try {
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    await Promise.all(applications.map(({ app }) => app.close()));
    await database.onModuleDestroy();
  }
});

function api(
  path: string,
  method = 'GET',
  body?: unknown,
  user: number | null = 0,
  instance = 0,
  requestOrigin = origin,
) {
  return fetch(`${applications[instance]!.base}/api/v1${path}`, {
    method,
    headers: {
      ...(user === null ? {} : { Cookie: cookies[user]! }),
      ...(method === 'GET' ? {} : { Origin: requestOrigin }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createProject(name = '工作流编辑测试') {
  const response = await api('/projects', 'POST', { name });
  expect(response.status).toBe(201);
  return projectSchema.parse(await response.json());
}

async function readWorkflow(projectId: string, instance = 0) {
  const response = await api(
    `/projects/${projectId}/workflow`,
    'GET',
    undefined,
    0,
    instance,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return workflowResponseSchema.parse(await response.json());
}

function definition(prompt: string): WorkflowDefinition {
  return {
    inputs: [],
    nodes: [
      {
        id: 'text',
        type: 'ai.text_generate',
        typeVersion: 1,
        name: '文本生成',
        inputs: { prompt: { type: 'constant', value: prompt } },
        // 编辑草稿允许尚未选择模型，本测试不会发布或执行这个节点。
        config: {},
        ui: { position: { x: 12, y: 34 } },
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
}

describe('默认 Workflow 初始化、读取与草稿保存 HTTP', () => {
  it('新建项目即持久化独立 Workflow；另一 API 实例可以读取，且不发布或运行', async () => {
    const project = await createProject();
    const workflow = await readWorkflow(project.id, 1);
    expect(workflow).toMatchObject({
      projectId: project.id,
      revision: 1,
      draft: emptyDraft,
    });
    expect(workflow.id).not.toBe(project.id);
    expect(await db.workflow.count({ where: { projectId: project.id } })).toBe(
      1,
    );
    const initialized = await api(`/projects/${project.id}/workflow`, 'POST');
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toEqual(workflow);
    expect(
      await db.workflowVersion.count({ where: { workflowId: workflow.id } }),
    ).toBe(0);
    expect(
      await db.workflowRun.count({ where: { projectId: project.id } }),
    ).toBe(0);
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRun: { projectId: project.id } },
      }),
    ).toBe(0);
  });

  it('新项目的 Workflow 创建失败时 Project 一同回滚', async () => {
    const name = `atomic-${randomUUID()}`;
    const guard = `test_workflow_${randomUUID().replaceAll('-', '')}`;
    // 只拒绝本用例的项目；验证真实嵌套写入事务，不替换生产数据库或服务。
    await db.$executeRawUnsafe(`CREATE FUNCTION "${guard}"() RETURNS TRIGGER AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "canvas_project" WHERE "id" = NEW."projectId" AND "name" = '${name}') THEN
          RAISE EXCEPTION 'test workflow creation failure';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    try {
      await db.$executeRawUnsafe(
        `CREATE TRIGGER "${guard}" BEFORE INSERT ON "workflow" FOR EACH ROW EXECUTE FUNCTION "${guard}"()`,
      );
      const response = await api('/projects', 'POST', { name });
      expect(response.status).toBe(500);
      expect(
        await db.project.count({ where: { ownerId: userIds[0], name } }),
      ).toBe(0);
    } finally {
      await db.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${guard}" ON "workflow"`,
      );
      await db.$executeRawUnsafe(`DROP FUNCTION "${guard}"()`);
    }
  });

  it('读取旧项目不会写库；两个 API 实例的 12 次初始化得到同一默认 Workflow', async () => {
    const project = await db.project.create({
      data: {
        ownerId: userIds[0]!,
        name: '尚未初始化',
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    const path = `/projects/${project.id}/workflow`;
    expect((await api(path)).status).toBe(404);
    expect(await db.workflow.count({ where: { projectId: project.id } })).toBe(
      0,
    );
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        api(path, 'POST', {}, 0, index % 2),
      ),
    );
    const workflows = [];
    for (const response of responses) {
      expect(response.status).toBe(200);
      workflows.push(workflowResponseSchema.parse(await response.json()));
    }
    expect(new Set(workflows.map(({ id }) => id)).size).toBe(1);
    expect(workflows.every((workflow) => workflow.revision === 1)).toBe(true);
    expect(await db.workflow.count({ where: { projectId: project.id } })).toBe(
      1,
    );
    expect(
      await db.project.findUniqueOrThrow({ where: { id: project.id } }),
    ).toEqual(project);
    expect(await readWorkflow(project.id)).toEqual(workflows[0]);
  });

  it('草稿保存与 Project revision 独立；重新初始化不覆盖草稿或更新任何修订', async () => {
    const project = await createProject();
    const workflow = await readWorkflow(project.id);
    for (const revision of [1, 2]) {
      const response = await api(`/projects/${project.id}`, 'PUT', {
        name: `项目修订 ${revision + 1}`,
        revision,
        viewport: project.viewport,
      });
      expect(response.status).toBe(200);
    }
    const projectBefore = await db.project.findUniqueOrThrow({
      where: { id: project.id },
    });
    const draft = definition('尚未选择模型的草稿');
    const response = await api(`/workflows/${workflow.id}/draft`, 'PUT', {
      expectedRevision: 1,
      definition: draft,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 2 });
    const saved = await readWorkflow(project.id, 1);
    expect(saved).toMatchObject({ id: workflow.id, revision: 2, draft });
    const initialized = await api(
      `/projects/${project.id}/workflow`,
      'POST',
      {},
    );
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toEqual(saved);
    expect(
      await db.project.findUniqueOrThrow({ where: { id: project.id } }),
    ).toEqual(projectBefore);
    expect(
      await db.workflowVersion.count({ where: { workflowId: workflow.id } }),
    ).toBe(0);
    expect(
      await db.workflowRun.count({ where: { projectId: project.id } }),
    ).toBe(0);
  });

  it('跨 API 实例同 revision 的并发保存只有一个成功，stale revision 不覆盖新内容', async () => {
    const project = await createProject();
    const workflow = await readWorkflow(project.id);
    const requests = Array.from({ length: 12 }, (_, index) =>
      definition(`草稿 ${index}`),
    );
    const responses = await Promise.all(
      requests.map((draft, index) =>
        api(
          `/workflows/${workflow.id}/draft`,
          'PUT',
          { expectedRevision: 1, definition: draft },
          0,
          index % 2,
        ),
      ),
    );
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(1);
    for (const response of responses) {
      expect([200, 409]).toContain(response.status);
      if (response.status === 409)
        expect(await response.json()).toMatchObject({
          code: 'WORKFLOW_REVISION_CONFLICT',
        });
      else expect(await response.json()).toEqual({ revision: 2 });
    }
    const saved = await readWorkflow(project.id);
    expect(saved.draft).toEqual(
      requests[responses.findIndex(({ status }) => status === 200)],
    );
    const stale = await api(`/workflows/${workflow.id}/draft`, 'PUT', {
      expectedRevision: 1,
      definition: emptyDraft,
    });
    expect(stale.status).toBe(409);
    expect(await readWorkflow(project.id)).toEqual(saved);
  });

  it('未登录、其他所有者、缺失资源与不可信 Origin 不能读取或写入', async () => {
    const project = await createProject();
    const workflow = await readWorkflow(project.id);
    const legacy = await db.project.create({
      data: { ownerId: userIds[0]!, name: '受保护的旧项目', viewport: {} },
    });
    const save = { expectedRevision: 1, definition: definition('越权修改') };
    for (const [path, method, body] of [
      [`/projects/${project.id}/workflow`, 'GET', undefined],
      [`/projects/${project.id}/workflow`, 'POST', {}],
      [`/projects/${legacy.id}/workflow`, 'POST', {}],
      [`/workflows/${workflow.id}/draft`, 'PUT', save],
    ] as const) {
      expect((await api(path, method, body, null)).status).toBe(401);
      expect((await api(path, method, body, 1)).status).toBe(404);
      if (method !== 'GET')
        expect(
          (await api(path, method, body, 0, 0, 'https://untrusted.invalid'))
            .status,
        ).toBe(403);
    }
    for (const [path, method, body] of [
      [`/projects/${randomUUID()}/workflow`, 'GET', undefined],
      [`/projects/${randomUUID()}/workflow`, 'POST', {}],
      [`/workflows/${randomUUID()}/draft`, 'PUT', save],
    ] as const)
      expect((await api(path, method, body)).status).toBe(404);
    expect(await db.workflow.count({ where: { projectId: legacy.id } })).toBe(
      0,
    );
    expect(await readWorkflow(project.id)).toEqual(workflow);
  });

  it('所有者改变后每次操作重新鉴权，不沿用此前读取权限', async () => {
    const project = await createProject();
    const workflow = await readWorkflow(project.id);
    await db.project.update({
      where: { id: project.id },
      data: { ownerId: userIds[1] },
    });
    expect((await api(`/projects/${project.id}/workflow`)).status).toBe(404);
    expect(
      (await api(`/projects/${project.id}/workflow`, 'POST', {})).status,
    ).toBe(404);
    expect(
      (
        await api(`/workflows/${workflow.id}/draft`, 'PUT', {
          expectedRevision: 1,
          definition: emptyDraft,
        })
      ).status,
    ).toBe(404);
    const response = await api(
      `/projects/${project.id}/workflow`,
      'POST',
      {},
      1,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(workflow);
  });

  it('严格拒绝身份覆盖、revision 混用、无效定义和秘密配置；不执行发布级校验', async () => {
    const project = await createProject();
    const workflow = await readWorkflow(project.id);
    const request = { expectedRevision: 1, definition: emptyDraft };
    for (const body of [
      { ...request, ownerId: userIds[1] },
      { ...request, workflowId: 'other' },
      { revision: 1, definition: emptyDraft },
      { ...request, publish: true },
      { ...request, expectedRevision: 0 },
      { ...request, definition: { nodes: [] } },
    ])
      expect(
        (await api(`/workflows/${workflow.id}/draft`, 'PUT', body)).status,
      ).toBe(400);
    for (const body of [null, { workflowId: 'other' }, { draft: emptyDraft }])
      expect(
        (await api(`/projects/${project.id}/workflow`, 'POST', body)).status,
      ).toBe(400);
    expect((await api('/projects/invalid/workflow')).status).toBe(400);
    const unsafe = definition('秘密不能写入节点配置');
    unsafe.nodes[0]!.config = { apiKey: 'test-secret-marker' };
    const response = await api(`/workflows/${workflow.id}/draft`, 'PUT', {
      expectedRevision: 1,
      definition: unsafe,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('test-secret-marker');
    expect(await readWorkflow(project.id)).toEqual(workflow);
  });

  it('保存不改写已有发布版本，也不生成 Run 或 Outbox', async () => {
    const project = await createProject();
    const workflow = await readWorkflow(project.id);
    const service = createWorkflowService(
      database,
      new NodeRegistry([createTextGenerationNodeType()]),
    );
    const version = await service.publish(userIds[0]!, {
      workflowId: workflow.id,
      expectedRevision: 1,
    });
    const persisted = await db.workflowVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    const response = await api(`/workflows/${workflow.id}/draft`, 'PUT', {
      expectedRevision: 1,
      definition: definition('修改已发布流程的草稿'),
    });
    expect(response.status).toBe(200);
    expect(
      await db.workflowVersion.findUniqueOrThrow({ where: { id: version.id } }),
    ).toEqual(persisted);
    expect(
      await db.workflowVersion.count({ where: { workflowId: workflow.id } }),
    ).toBe(1);
    expect(
      (
        await api(`/workflows/${workflow.id}/publish`, 'POST', {
          expectedRevision: 2,
        })
      ).status,
    ).toBe(400);
    expect(
      await db.workflowRun.count({ where: { projectId: project.id } }),
    ).toBe(0);
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRun: { projectId: project.id } },
      }),
    ).toBe(0);
  });
});
