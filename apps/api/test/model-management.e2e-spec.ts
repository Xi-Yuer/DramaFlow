import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  projectSchema,
  modelProviderSchema,
  managedModelConfigurationSchema,
  providerPluginCatalogSchema,
  providerCatalogSchema,
  modelProviderListSchema,
  modelConfigurationListSchema,
  workflowResponseSchema,
  workflowVersionResponseSchema,
  StringType,
} from '@dramaflow/contracts';
import { DatabaseService, SecretsService } from '@dramaflow/server';
import type { Type } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthService } from '../src/auth/auth.service.js';
import { authBaseUrl } from '../src/auth/trusted-origin.js';
import { mountAuth } from '../src/auth/auth.http.js';
import { ApiExceptionFilter } from '../src/http/exception.filter.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test' ||
  !process.env.WORKFLOW_QUEUE_PREFIX?.startsWith('dramaflow-test-')
)
  throw new Error('模型管理测试仅允许隔离库和队列');

const database = new DatabaseService();
const db = database.client;
const origin = new URL(authBaseUrl()).origin;
const users: string[] = [],
  cookies: string[] = [];
const marker = `management-secret-${randomUUID()}`;
let app: NestExpressApplication, base: string;
let log: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
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
  base = await app.getUrl();
  for (const name of ['所有者', '其他用户']) {
    const email = `models-${randomUUID()}@example.test`,
      password = randomBytes(24).toString('hex');
    const { user } = await auth.auth.api.createUser({
      body: { email, password, name, role: 'user' },
    });
    users.push(user.id);
    const response = await auth.auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    cookies.push(
      response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    );
  }
  log = vi.spyOn(Logger.prototype, 'error');
});
afterAll(async () => {
  try {
    expect(JSON.stringify(log?.mock.calls ?? [])).not.toContain(marker);
  } finally {
    log?.mockRestore();
    await db.user.deleteMany({ where: { id: { in: users } } });
    if (app) await app.close();
    await database.onModuleDestroy();
  }
});
async function http(
  path: string,
  method = 'GET',
  body?: unknown,
  actor = 0,
  requestOrigin = origin,
) {
  return fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...(actor < 0 ? {} : { Cookie: cookies[actor]! }),
      Origin: requestOrigin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(response: Response) {
  const text = await response.text();
  expect(text).not.toContain(marker);
  expect(text).not.toContain('encryptedCredentials');
  expect(response.headers.get('cache-control')).toBe('no-store');
  return JSON.parse(text) as unknown;
}
async function project(actor = 0) {
  const response = await http('/projects', 'POST', { name: '模型管理' }, actor);
  return projectSchema.parse(await response.json());
}
const providerBody = () => ({
  name: '自定义兼容服务',
  pluginId: 'openai_compatible',
  pluginVersion: 1,
  configuration: { baseURL: 'http://127.0.0.1:1/custom/v1' },
  credentials: { apiKey: marker },
});
async function provider(projectId: string) {
  const response = await http(
    `/projects/${projectId}/providers`,
    'POST',
    providerBody(),
  );
  expect(response.status).toBe(201);
  return modelProviderSchema.parse(await json(response));
}
async function model(projectId: string, providerId: string) {
  const response = await http(
    `/projects/${projectId}/model-configurations`,
    'POST',
    {
      providerId,
      capability: 'text.generate',
      model: 'explicit-compatible-model',
      settings: { temperature: 0.5, maxOutputTokens: 64 },
    },
  );
  expect(response.status).toBe(201);
  return managedModelConfigurationSchema.parse(await json(response));
}
async function fixture() {
  const p = await project();
  const v = await provider(p.id);
  const m = await model(p.id, v.id);
  return {
    p,
    v,
    m,
    providers: `/projects/${p.id}/providers`,
    models: `/projects/${p.id}/model-configurations`,
  };
}

describe('项目模型管理 HTTP', () => {
  it('受鉴权的安全目录来自正式插件，包含配置 Schema 和能力参数，不返回执行实现', async () => {
    expect((await http('/provider-plugins', 'GET', undefined, -1)).status).toBe(
      401,
    );
    const result = providerPluginCatalogSchema.parse(
      await json(await http('/provider-plugins')),
    );
    expect(result.items.map(({ id, version }) => ({ id, version }))).toEqual([
      { id: 'openai_compatible', version: 1 },
      { id: 'text_generation', version: 1 },
    ]);
    expect(result.items[0]).toMatchObject({
      id: 'openai_compatible',
      version: 1,
      credentialFields: [
        { key: 'apiKey', required: true, minLength: 1, maxLength: 4096 },
      ],
      capabilities: [{ type: 'text.generate' }],
    });
    expect(result.items[0]!.configurationSchema).toMatchObject({
      properties: {
        baseURL: { type: 'string', format: 'uri' },
        timeoutMs: { default: 60000 },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /invoke|credentialsSchema|encryptedCredentials/,
    );
  });

  it('Provider Catalog 发布 OpenAI / Anthropic，实例绑定定义并物化官方调用配置', async () => {
    expect((await http('/provider-catalog', 'GET', undefined, -1)).status).toBe(401);
    const catalog = providerCatalogSchema.parse(await json(await http('/provider-catalog')));
    expect(catalog.items.map((item) => item.id)).toEqual(['anthropic', 'openai']);
    expect(new Set(catalog.items.map((item) => item.id)).size).toBe(2);
    expect(JSON.stringify(catalog)).not.toMatch(
      /text_generation|pluginId|pluginVersion|baseURL|api\.openai\.com|api\.anthropic\.com|vercel|encryptedCredentials/,
    );
    const owned = await project();
    const created = await http(`/projects/${owned.id}/providers/catalog`, 'POST', {
      name: '官方 OpenAI',
      providerDefinitionId: 'openai',
      credentials: { apiKey: marker },
    });
    expect(created.status).toBe(201);
    const openai = modelProviderSchema.parse(await json(created));
    expect(openai).toMatchObject({
      providerDefinitionId: 'openai',
      pluginId: 'text_generation',
      pluginVersion: 1,
      configuration: {
        provider: 'openai',
        baseURL: 'https://api.openai.com/v1',
        timeoutMs: 60000,
      },
    });
    expect(JSON.stringify(openai)).not.toContain(marker);
    expect(
      (await http(`/projects/${owned.id}/providers/${openai.id}`, 'GET', undefined, 1)).status,
    ).toBe(404);
    const anthropicResponse = await http(`/projects/${owned.id}/providers/catalog`, 'POST', {
      name: '官方 Anthropic',
      providerDefinitionId: 'anthropic',
      credentials: { apiKey: marker },
      configuration: {},
    });
    expect(anthropicResponse.status).toBe(201);
    expect(modelProviderSchema.parse(await json(anthropicResponse))).toMatchObject({
      providerDefinitionId: 'anthropic',
      pluginId: 'text_generation',
      pluginVersion: 1,
      configuration: { provider: 'anthropic', baseURL: 'https://api.anthropic.com/v1' },
    });
    const configured = await http(`/projects/${owned.id}/model-configurations`, 'POST', {
      providerId: openai.id,
      capability: 'text.generate',
      model: 'gpt-4o',
      settings: { temperature: 0.2, maxOutputTokens: 32 },
    });
    expect(configured.status).toBe(201);
    expect(managedModelConfigurationSchema.parse(await json(configured)).availability).toEqual({
      selectable: true,
      unavailableReason: null,
    });
    for (const body of [
      { name: '未知服务', providerDefinitionId: 'deepseek', credentials: { apiKey: marker } },
      {
        name: '改地址',
        providerDefinitionId: 'openai',
        credentials: { apiKey: marker },
        configuration: { baseURL: 'https://evil.example/v1' },
      },
      {
        name: '伪造插件',
        providerDefinitionId: 'openai',
        pluginId: 'text_generation',
        credentials: { apiKey: marker },
      },
    ]) {
      const rejected = await http(`/projects/${owned.id}/providers/catalog`, 'POST', body);
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).not.toContain(marker);
    }
    expect((await provider(owned.id)).providerDefinitionId).toBeNull();
  });

  it('自定义兼容 endpoint / model 经正式 API 创建、列出和读取，无默认厂商且不解密或探活', async () => {
    const decrypt = vi.spyOn(SecretsService.prototype, 'decrypt');
    let f: Awaited<ReturnType<typeof fixture>>;
    try {
      f = await fixture();
      expect(f.v.configuration).toEqual({
        baseURL: 'http://127.0.0.1:1/custom/v1',
        timeoutMs: 60000,
      });
      expect(f.m.availability).toEqual({
        selectable: true,
        unavailableReason: null,
      });
      expect(
        modelProviderListSchema.parse(await json(await http(f.providers)))
          .items,
      ).toEqual([f.v]);
      expect(
        modelConfigurationListSchema.parse(await json(await http(f.models)))
          .items,
      ).toEqual([f.m]);
      expect(
        modelProviderSchema.parse(
          await json(await http(`${f.providers}/${f.v.id}`)),
        ),
      ).toEqual(f.v);
      expect(
        managedModelConfigurationSchema.parse(
          await json(await http(`${f.models}/${f.m.id}`)),
        ),
      ).toEqual(f.m);
      expect(decrypt).not.toHaveBeenCalled();
    } finally {
      decrypt.mockRestore();
    }
    const row = await db.modelProvider.findUniqueOrThrow({
      where: { id: f.v.id },
    });
    expect(row.encryptedCredentials).not.toContain(marker);
    expect(
      JSON.parse(
        new SecretsService().decrypt(row.encryptedCredentials, users[0]!),
      ),
    ).toEqual({ apiKey: marker });
    expect(await db.workflowRun.count({ where: { projectId: f.p.id } })).toBe(
      0,
    );
  });

  it('所有目录 / 详情读取也必须登录', async () => {
    const f = await fixture();
    for (const path of [
      f.providers,
      `${f.providers}/${f.v.id}`,
      f.models,
      `${f.models}/${f.m.id}`,
    ]) {
      const response = await http(path, 'GET', undefined, -1);
      expect(response.status).toBe(401);
      await json(response);
    }
  });

  it('历史配置缺少插件 / 能力或参数失效时，选择器显示安全原因，不解密坏凭证', async () => {
    const p = await project();
    for (const reason of [
      'PLUGIN_UNAVAILABLE',
      'CAPABILITY_UNAVAILABLE',
      'CONFIGURATION_INVALID',
    ] as const) {
      // 模拟无法再通过当前管理 API 创建的历史绑定，不替换正式 Registry。
      const v = await db.modelProvider.create({
        data: {
          projectId: p.id,
          name: '历史配置',
          pluginId:
            reason === 'PLUGIN_UNAVAILABLE'
              ? 'missing_plugin'
              : 'openai_compatible',
          pluginVersion: 1,
          configuration:
            reason === 'CONFIGURATION_INVALID'
              ? { baseURL: 'https://example.test/v1', timeoutMs: 0 }
              : { baseURL: 'https://example.test/v1', timeoutMs: 60000 },
          encryptedCredentials: 'unreadable-test-envelope',
        },
      });
      const m = await db.modelConfiguration.create({
        data: {
          projectId: p.id,
          providerId: v.id,
          capability:
            reason === 'CAPABILITY_UNAVAILABLE'
              ? 'video.generate'
              : 'text.generate',
          model: 'historical-model',
          settings: {},
        },
      });
      const result = managedModelConfigurationSchema.parse(
        await json(
          await http(`/projects/${p.id}/model-configurations/${m.id}`),
        ),
      );
      expect(result.availability).toEqual({
        selectable: false,
        unavailableReason: reason,
      });
      if (reason === 'CONFIGURATION_INVALID') {
        const before = await db.modelConfiguration.count({
          where: { projectId: p.id },
        });
        const create = await http(
          `/projects/${p.id}/model-configurations`,
          'POST',
          {
            providerId: v.id,
            capability: 'text.generate',
            model: 'new-model',
            settings: {},
          },
        );
        expect(create.status).toBe(400);
        await json(create);
        expect(
          await db.modelConfiguration.count({ where: { projectId: p.id } }),
        ).toBe(before);
      }
    }
  });

  it('启停独立管理：停用 Provider 不改模型绑定，模型重新启用不隐式启用 Provider', async () => {
    const f = await fixture();
    expect(
      (await http(`${f.providers}/${f.v.id}`, 'PATCH', { enabled: false }))
        .status,
    ).toBe(200);
    let m = managedModelConfigurationSchema.parse(
      await json(await http(`${f.models}/${f.m.id}`)),
    );
    expect(m.enabled).toBe(true);
    expect(m.availability.unavailableReason).toBe('PROVIDER_DISABLED');
    const blocked = await http(f.models, 'POST', {
      providerId: f.v.id,
      capability: 'text.generate',
      model: 'another',
      settings: {},
    });
    expect(blocked.status).toBe(409);
    await json(blocked);
    await http(`${f.models}/${f.m.id}`, 'PATCH', { enabled: false });
    m = managedModelConfigurationSchema.parse(
      await json(await http(`${f.models}/${f.m.id}`)),
    );
    expect(m.availability.unavailableReason).toBe('MODEL_DISABLED');
    await http(`${f.models}/${f.m.id}`, 'PATCH', { enabled: true });
    expect(
      managedModelConfigurationSchema.parse(
        await json(await http(`${f.models}/${f.m.id}`)),
      ).availability.unavailableReason,
    ).toBe('PROVIDER_DISABLED');
    await http(`${f.providers}/${f.v.id}`, 'PATCH', { enabled: true });
    expect(
      managedModelConfigurationSchema.parse(
        await json(await http(`${f.models}/${f.m.id}`)),
      ),
    ).toEqual(f.m);
  });

  it('凭证轮换只替换密文，停用时也可轮换；失败保留旧凭证', async () => {
    const f = await fixture();
    const before = await db.modelProvider.findUniqueOrThrow({
      where: { id: f.v.id },
    });
    await http(`${f.providers}/${f.v.id}`, 'PATCH', { enabled: false });
    const rotated = await http(`${f.providers}/${f.v.id}/credentials`, 'PUT', {
      credentials: { apiKey: `${marker}-rotated` },
    });
    expect(rotated.status).toBe(204);
    expect(await rotated.text()).toBe('');
    const after = await db.modelProvider.findUniqueOrThrow({
      where: { id: f.v.id },
    });
    expect(after.encryptedCredentials).not.toBe(before.encryptedCredentials);
    expect(
      JSON.parse(
        new SecretsService().decrypt(after.encryptedCredentials, users[0]!),
      ),
    ).toEqual({ apiKey: `${marker}-rotated` });
    expect(after.configuration).toEqual(before.configuration);
    expect(after.enabled).toBe(false);
    const failed = await http(`${f.providers}/${f.v.id}/credentials`, 'PUT', {
      credentials: { [marker]: marker },
    });
    expect(failed.status).toBe(400);
    await json(failed);
    expect(
      (await db.modelProvider.findUniqueOrThrow({ where: { id: f.v.id } }))
        .encryptedCredentials,
    ).toBe(after.encryptedCredentials);
  });

  it('所有列表、读取、创建、启停和轮换均隔离其他用户和其他项目', async () => {
    const f = await fixture();
    const other = await project();
    for (const [path, method, body] of [
      [f.providers, 'GET', undefined],
      [`${f.providers}/${f.v.id}`, 'GET', undefined],
      [f.providers, 'POST', providerBody()],
      [`${f.providers}/${f.v.id}`, 'PATCH', { enabled: false }],
      [
        `${f.providers}/${f.v.id}/credentials`,
        'PUT',
        { credentials: { apiKey: marker } },
      ],
      [f.models, 'GET', undefined],
      [`${f.models}/${f.m.id}`, 'GET', undefined],
      [
        f.models,
        'POST',
        {
          providerId: f.v.id,
          capability: 'text.generate',
          model: 'x',
          settings: {},
        },
      ],
      [`${f.models}/${f.m.id}`, 'PATCH', { enabled: false }],
    ] as const) {
      const denied = await http(path, method, body, 1);
      expect(denied.status).toBe(404);
      await json(denied);
    }
    for (const path of [
      `/projects/${other.id}/providers/${f.v.id}`,
      `/projects/${other.id}/model-configurations/${f.m.id}`,
    ]) {
      expect((await http(path)).status).toBe(404);
      expect((await http(path, 'PATCH', { enabled: false })).status).toBe(404);
    }
    expect(
      (
        await http(
          `/projects/${other.id}/providers/${f.v.id}/credentials`,
          'PUT',
          { credentials: { apiKey: marker } },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await http(`/projects/${other.id}/model-configurations`, 'POST', {
          providerId: f.v.id,
          capability: 'text.generate',
          model: 'x',
          settings: {},
        })
      ).status,
    ).toBe(404);
    expect(
      modelProviderSchema.parse(
        await json(await http(`${f.providers}/${f.v.id}`)),
      ).enabled,
    ).toBe(true);
    expect((await http(`/projects/${randomUUID()}/providers`)).status).toBe(
      404,
    );
    expect(
      (await http(`/projects/${randomUUID()}/model-configurations`)).status,
    ).toBe(404);
  });

  it('未知插件 / 版本、未声明能力、错误参数与 URL 凭证均拒绝，不留下记录', async () => {
    const p = await project(),
      providers = `/projects/${p.id}/providers`;
    for (const body of [
      { ...providerBody(), pluginId: 'uninstalled' },
      { ...providerBody(), pluginVersion: 99 },
      {
        ...providerBody(),
        configuration: { baseURL: `https://user:${marker}@example.test/v1` },
      },
      {
        ...providerBody(),
        configuration: { baseURL: 'https://example.test/v1', [marker]: marker },
      },
      { ...providerBody(), credentials: { apiKey: '' } },
      {
        ...providerBody(),
        configuration: { baseURL: 'https://example.test/v1', timeoutMs: 0 },
      },
      { ...providerBody(), projectId: p.id },
    ]) {
      const response = await http(providers, 'POST', body);
      expect(response.status).toBe(400);
      await json(response);
    }
    expect(await db.modelProvider.count({ where: { projectId: p.id } })).toBe(
      0,
    );
    const v = await provider(p.id);
    for (const body of [
      {
        providerId: v.id,
        capability: 'video.generate',
        model: 'x',
        settings: {},
      },
      {
        providerId: v.id,
        capability: 'text.generate',
        model: ' ',
        settings: {},
      },
      {
        providerId: v.id,
        capability: 'text.generate',
        model: 'x',
        settings: { temperature: 3 },
      },
      {
        providerId: v.id,
        capability: 'text.generate',
        model: 'x',
        settings: { [marker]: marker },
      },
    ]) {
      const response = await http(
        `/projects/${p.id}/model-configurations`,
        'POST',
        body,
      );
      expect(response.status).toBe(400);
      await json(response);
    }
    expect(
      await db.modelConfiguration.count({ where: { projectId: p.id } }),
    ).toBe(0);
  });

  it('PATCH 拒绝修改不可变语义；认证和 Origin 保护所有管理写入', async () => {
    const f = await fixture();
    for (const body of [
      { name: '新名称' },
      { configuration: { baseURL: 'http://another.test' } },
      { pluginId: 'other' },
      { credentials: { apiKey: marker } },
      { projectId: f.p.id },
      {},
    ]) {
      const response = await http(`${f.providers}/${f.v.id}`, 'PATCH', {
        enabled: true,
        ...body,
        ...(Object.keys(body).length ? {} : { enabled: marker }),
      });
      expect(response.status).toBe(400);
      await json(response);
    }
    for (const body of [
      { model: 'other' },
      { providerId: randomUUID() },
      { capability: 'image.generate' },
      { settings: { temperature: 0 } },
    ]) {
      expect(
        (
          await http(`${f.models}/${f.m.id}`, 'PATCH', {
            enabled: true,
            ...body,
          })
        ).status,
      ).toBe(400);
    }
    for (const [path, method, body] of [
      [f.providers, 'POST', providerBody()],
      [`${f.providers}/${f.v.id}`, 'PATCH', { enabled: false }],
      [
        `${f.providers}/${f.v.id}/credentials`,
        'PUT',
        { credentials: { apiKey: marker } },
      ],
      [
        f.models,
        'POST',
        {
          providerId: f.v.id,
          capability: 'text.generate',
          model: 'x',
          settings: {},
        },
      ],
      [`${f.models}/${f.m.id}`, 'PATCH', { enabled: false }],
    ] as const) {
      expect((await http(path, method, body, -1)).status).toBe(401);
      const response = await http(
        path,
        method,
        body,
        0,
        'https://untrusted.example',
      );
      expect(response.status).toBe(403);
      await json(response);
    }
  });

  it('非法 JSON、敏感未知字段和加密故障均脱敏，失败不改变数据库', async () => {
    const p = await project(),
      path = `/projects/${p.id}/providers`;
    const malformed = await fetch(`${base}/api/v1${path}`, {
      method: 'POST',
      headers: {
        Cookie: cookies[0]!,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: `{"credentials":{"apiKey":"${marker}"},invalid}`,
    });
    expect(malformed.status).toBe(400);
    await json(malformed);
    const oversized = await http(path, 'POST', {
      ...providerBody(),
      credentials: { apiKey: marker.repeat(30000) },
    });
    expect(oversized.status).toBe(413);
    await json(oversized);
    const v = await provider(p.id);
    const before = await db.modelProvider.findUniqueOrThrow({
      where: { id: v.id },
    });
    const encrypt = vi
      .spyOn(SecretsService.prototype, 'encrypt')
      .mockImplementation(() => {
        throw new Error(marker);
      });
    try {
      const created = await http(path, 'POST', providerBody());
      expect(created.status).toBe(503);
      await json(created);
      const rotated = await http(`${path}/${v.id}/credentials`, 'PUT', {
        credentials: { apiKey: marker },
      });
      expect(rotated.status).toBe(503);
      await json(rotated);
    } finally {
      encrypt.mockRestore();
    }
    expect(
      (await db.modelProvider.findUniqueOrThrow({ where: { id: v.id } }))
        .encryptedCredentials,
    ).toBe(before.encryptedCredentials);
    expect(await db.modelProvider.count({ where: { projectId: p.id } })).toBe(
      1,
    );
  });

  it('启停与轮换并发只修改各自字段，恢复后模型身份保持不变', async () => {
    const f = await fixture();
    const responses = await Promise.all([
      http(`${f.providers}/${f.v.id}`, 'PATCH', { enabled: false }),
      http(`${f.providers}/${f.v.id}/credentials`, 'PUT', {
        credentials: { apiKey: `${marker}-parallel` },
      }),
      http(`${f.models}/${f.m.id}`, 'PATCH', { enabled: false }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 204, 200]);
    const row = await db.modelProvider.findUniqueOrThrow({
      where: { id: f.v.id },
    });
    expect(row.enabled).toBe(false);
    expect(
      new SecretsService().decrypt(row.encryptedCredentials, users[0]!),
    ).toContain(`${marker}-parallel`);
    expect(
      (await db.modelConfiguration.findUniqueOrThrow({ where: { id: f.m.id } }))
        .enabled,
    ).toBe(false);
    await http(`${f.providers}/${f.v.id}`, 'PATCH', { enabled: true });
    await http(`${f.models}/${f.m.id}`, 'PATCH', { enabled: true });
    expect(
      managedModelConfigurationSchema.parse(
        await json(await http(`${f.models}/${f.m.id}`)),
      ),
    ).toEqual(f.m);
  });

  it('管理变更不改写旧发布快照；启停影响新发布，不推进 Project / Workflow revision', async () => {
    const f = await fixture();
    const workflow = workflowResponseSchema.parse(
      await (await http(`/projects/${f.p.id}/workflow`)).json(),
    );
    const draft = {
      inputs: [],
      edges: [],
      outputs: [
        {
          name: 'text',
          type: StringType,
          source: { nodeId: 'text', outputKey: 'text' },
        },
      ],
      nodes: [
        {
          id: 'text',
          type: 'ai.text_generate',
          typeVersion: 1,
          name: '生成',
          inputs: { prompt: { type: 'constant', value: '写作' } },
          config: { modelConfigurationId: f.m.id },
          ui: { position: { x: 0, y: 0 } },
        },
      ],
    };
    const saved = await http(`/workflows/${workflow.id}/draft`, 'PUT', {
      expectedRevision: workflow.revision,
      definition: draft,
    });
    expect(saved.status).toBe(200);
    const revision = z
      .object({ revision: z.number() })
      .parse(await saved.json()).revision;
    const published = await http(`/workflows/${workflow.id}/publish`, 'POST', {
      expectedRevision: revision,
    });
    expect(published.status).toBe(201);
    const version = workflowVersionResponseSchema.parse(await published.json());
    await http(`${f.providers}/${f.v.id}`, 'PATCH', { enabled: false });
    await http(`${f.providers}/${f.v.id}/credentials`, 'PUT', {
      credentials: { apiKey: `${marker}-later` },
    });
    expect(
      workflowVersionResponseSchema.parse(
        await (await http(`/workflow-versions/${version.id}`)).json(),
      ),
    ).toEqual(version);
    const nextSaved = await http(`/workflows/${workflow.id}/draft`, 'PUT', {
      expectedRevision: revision,
      definition: draft,
    });
    const nextRevision = z
      .object({ revision: z.number() })
      .parse(await nextSaved.json()).revision;
    expect(
      (
        await http(`/workflows/${workflow.id}/publish`, 'POST', {
          expectedRevision: nextRevision,
        })
      ).status,
    ).toBe(400);
    expect(
      await db.workflowVersion.count({ where: { workflowId: workflow.id } }),
    ).toBe(1);
    expect(
      projectSchema.parse(await (await http(`/projects/${f.p.id}`)).json())
        .revision,
    ).toBe(f.p.revision);
    await http(`${f.providers}/${f.v.id}`, 'PATCH', { enabled: true });
    expect(
      (
        await http(`/workflows/${workflow.id}/publish`, 'POST', {
          expectedRevision: nextRevision,
        })
      ).status,
    ).toBe(201);
    expect(
      workflowResponseSchema.parse(
        await (await http(`/projects/${f.p.id}/workflow`)).json(),
      ).revision,
    ).toBe(nextRevision);
  });

  it('两个列表有界分页，在相同时间戳下完整遍历，不接受跨项目游标', async () => {
    const p = await project(),
      other = await project();
    const v = await provider(p.id),
      foreign = await provider(other.id);
    const createdAt = new Date('2026-10-21T00:00:00.000Z');
    // 分页边界用固定时间戳构造批量数据，正常产品链由前面的正式 HTTP 用例验证。
    await db.modelProvider.createMany({
      data: Array.from({ length: 51 }, (_, i) => ({
        id: randomUUID(),
        projectId: p.id,
        name: `分页 ${i}`,
        pluginId: v.pluginId,
        pluginVersion: v.pluginVersion,
        configuration: v.configuration,
        encryptedCredentials: 'test-unreadable-envelope',
        createdAt,
      })),
    });
    await db.modelConfiguration.createMany({
      data: Array.from({ length: 51 }, (_, i) => ({
        id: randomUUID(),
        projectId: p.id,
        providerId: v.id,
        capability: 'text.generate',
        model: `分页 ${i}`,
        settings: {},
        createdAt,
      })),
    });
    for (const [resource, schema, total] of [
      ['providers', modelProviderListSchema, 52],
      ['model-configurations', modelConfigurationListSchema, 51],
    ] as const) {
      const first = schema.parse(
        await json(await http(`/projects/${p.id}/${resource}`)),
      );
      expect(first.items).toHaveLength(50);
      expect(first.nextCursor).not.toBeNull();
      const second = schema.parse(
        await json(
          await http(
            `/projects/${p.id}/${resource}?cursor=${first.nextCursor}`,
          ),
        ),
      );
      expect(second.nextCursor).toBeNull();
      expect(
        new Set([...first.items, ...second.items].map((item) => item.id)).size,
      ).toBe(total);
      expect(
        (await http(`/projects/${p.id}/${resource}?cursor=${foreign.id}`))
          .status,
      ).toBe(400);
      expect(
        (await http(`/projects/${p.id}/${resource}?limit=10000`)).status,
      ).toBe(400);
    }
  });
});
