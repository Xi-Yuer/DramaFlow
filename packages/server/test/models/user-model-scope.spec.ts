import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ModelCatalog, PluginRegistry, ProviderCatalog } from '@dramaflow/plugins';
import type { Prisma } from '@dramaflow/database';
import {
  DatabaseService,
  ModelProviderService,
  SecretsService,
  WorkflowCapabilitiesFactory,
} from '../../src/index.js';

const ownerId = 'user-a';
const otherOwnerId = 'user-b';
const providerId = randomUUID();
const modelId = randomUUID();
const provider = {
  id: providerId,
  ownerId,
  name: 'DeepSeek',
  pluginId: 'scope_test',
  pluginVersion: 1,
  configuration: {},
  providerDefinitionId: null,
  enabled: true,
  encryptedCredentials: 'test-encrypted-value',
  createdAt: new Date(),
};
const model = {
  id: modelId,
  ownerId,
  providerId,
  capability: 'text.generate',
  model: 'deepseek-chat',
  settings: {},
  enabled: true,
  createdAt: new Date(),
};
function fixture() {
  const invoke = vi.fn().mockResolvedValue({ text: '业务文本' });
  const plugins = new PluginRegistry([
    {
      id: 'scope_test',
      version: 1,
      management: { name: 'Scope test' },
      configSchema: z.object({}).strict(),
      credentialsSchema: z.object({ apiKey: z.string() }).strict(),
      capabilities: [
        {
          type: 'text.generate',
          inputSchema: z.object({}),
          outputSchema: z.object({ text: z.string() }),
          modelSettingsSchema: z.object({}).strict(),
          invoke,
        },
      ],
    },
  ]);
  const catalog = new ProviderCatalog(plugins, []);
  const secrets = new SecretsService();
  const encrypt = vi.spyOn(secrets, 'encrypt').mockReturnValue('test-encrypted-value');
  const decrypt = vi.spyOn(secrets, 'decrypt').mockReturnValue('{"apiKey":"test-only-credential"}');
  const client = {
    modelProvider: {
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...provider, ...data })),
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.ownerId === ownerId && (!where.id || where.id === providerId) ? provider : null,
        ),
      findMany: vi
        .fn()
        .mockImplementation(async ({ where }) => (where.ownerId === ownerId ? [provider] : [])),
      updateMany: vi
        .fn()
        .mockImplementation(async ({ where }) => ({ count: where.ownerId === ownerId ? 1 : 0 })),
    },
    modelConfiguration: {
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...model, ...data })),
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.ownerId === ownerId && where.id === modelId ? { ...model, provider } : null,
        ),
      findMany: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.ownerId === ownerId ? [{ ...model, provider }] : [],
        ),
      updateMany: vi
        .fn()
        .mockImplementation(async ({ where }) => ({ count: where.ownerId === ownerId ? 1 : 0 })),
    },
    workflowRun: {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.project.ownerId === ownerId ? { id: where.id } : null,
        ),
    },
  };
  const db = { client } as unknown as DatabaseService;
  const service = new ModelProviderService(
    db,
    secrets,
    plugins,
    catalog,
    new ModelCatalog(catalog, []),
  );
  const capabilities = new WorkflowCapabilitiesFactory(db, secrets, plugins);
  return { client, service, capabilities, encrypt, decrypt, invoke };
}

beforeEach(() => vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', '01'.repeat(32)));
afterEach(() => vi.unstubAllEnvs());

describe('用户模型资源作用域', () => {
  it('创建归属认证用户；原模型 ID 的列表投影可被该用户所有项目复用，且不返回凭证', async () => {
    const f = fixture();
    const created = await f.service.createProvider(ownerId, {
      name: 'DeepSeek',
      pluginId: 'scope_test',
      pluginVersion: 1,
      configuration: {},
      credentials: { apiKey: 'test-only-credential' },
    });
    expect(created.ownerId).toBe(ownerId);
    expect(f.encrypt).toHaveBeenCalledWith('{"apiKey":"test-only-credential"}', ownerId);
    const configured = await f.service.createModelConfiguration(ownerId, {
      providerId,
      capability: 'text.generate',
      model: 'deepseek-chat',
      settings: {},
    });
    expect(configured.id).toBe(modelId);
    expect(configured.ownerId).toBe(ownerId);
    const listed = await f.service.listModelConfigurations(ownerId, {});
    expect(listed.items[0]?.id).toBe(modelId);
    expect(listed.items[0]?.availability.selectable).toBe(true);
    expect(JSON.stringify(await f.service.listProviders(ownerId, {}))).not.toMatch(
      /encryptedCredentials|test-only-credential|test-encrypted-value/,
    );
    expect(f.client.modelProvider.findMany.mock.calls[0]?.[0].select).not.toHaveProperty(
      'encryptedCredentials',
    );
    expect(f.decrypt).not.toHaveBeenCalled();
  });

  it('另一个用户不能读取、启停、轮换、使用 Provider 创建配置或借游标枚举', async () => {
    const f = fixture();
    expect((await f.service.listProviders(otherOwnerId, {})).items).toEqual([]);
    expect((await f.service.listModelConfigurations(otherOwnerId, {})).items).toEqual([]);
    for (const action of [
      () => f.service.getProvider(otherOwnerId, providerId),
      () => f.service.getManagedModelConfiguration(otherOwnerId, modelId),
      () => f.service.setProviderEnabled(otherOwnerId, providerId, false),
      () => f.service.setModelEnabled(otherOwnerId, modelId, false),
      () => f.service.replaceCredentials(otherOwnerId, providerId, { apiKey: 'test-replacement' }),
      () =>
        f.service.createModelConfiguration(otherOwnerId, {
          providerId,
          capability: 'text.generate',
          model: 'deepseek-chat',
          settings: {},
        }),
    ])
      await expect(action()).rejects.toMatchObject({ status: 404 });
    await expect(
      f.service.listProviders(otherOwnerId, { cursor: providerId }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.service.listModelConfigurations(otherOwnerId, { cursor: modelId }),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.encrypt).not.toHaveBeenCalled();
    expect(f.decrypt).not.toHaveBeenCalled();
  });

  it('用户 A 的不同项目（含新项目）调用同一个配置 ID，仍逐次核对 Run 与用户归属', async () => {
    const f = fixture();
    for (const projectId of [randomUUID(), randomUUID(), randomUUID()]) {
      await expect(
        f.capabilities
          .forRun(ownerId, projectId, randomUUID())
          .invoke('text.generate', { modelConfigurationId: modelId, input: {} }),
      ).resolves.toEqual({ text: '业务文本' });
    }
    expect(f.invoke).toHaveBeenCalledTimes(3);
    expect(
      f.client.modelConfiguration.findFirst.mock.calls.every(
        ([query]) => query.where.ownerId === ownerId && !('projectId' in query.where),
      ),
    ).toBe(true);
    expect(
      f.client.workflowRun.findFirst.mock.calls.every(
        ([query]) => query.where.project.ownerId === ownerId && query.where.status === 'running',
      ),
    ).toBe(true);
  });

  it('即便用户 B 拥有合法 Run，引用 A 的模型也在解密与执行前拒绝', async () => {
    const f = fixture();
    f.client.workflowRun.findFirst.mockResolvedValue({ id: 'run-b' });
    await expect(
      f.capabilities
        .forRun(otherOwnerId, randomUUID(), 'run-b')
        .invoke('text.generate', { modelConfigurationId: modelId, input: {} }),
    ).rejects.toMatchObject({ code: 'MODEL_CONFIGURATION_UNAVAILABLE' });
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('Runtime 也独立拒绝 Provider Owner 不匹配或 Run 越权', async () => {
    const f = fixture();
    await expect(
      f.capabilities
        .forRun(otherOwnerId, randomUUID(), 'wrong-run')
        .invoke('text.generate', { modelConfigurationId: modelId, input: {} }),
    ).rejects.toMatchObject({ code: 'MODEL_CONFIGURATION_UNAVAILABLE' });
    expect(f.client.modelConfiguration.findFirst).not.toHaveBeenCalled();
    f.client.modelConfiguration.findFirst.mockResolvedValue({
      ...model,
      provider: { ...provider, ownerId: otherOwnerId },
    });
    await expect(
      f.capabilities
        .forRun(ownerId, randomUUID(), 'own-run')
        .invoke('text.generate', { modelConfigurationId: modelId, input: {} }),
    ).rejects.toMatchObject({ code: 'MODEL_PROVIDER_UNAVAILABLE' });
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('Publish 事务按 Owner 绑定模型与 Provider，不受项目限制，也不解密或调用模型', async () => {
    const f = fixture();
    const query = vi
      .fn()
      .mockImplementation(async (sql: TemplateStringsArray, id: string, owner: string) => {
        expect(sql.join('?')).toContain('p."ownerId" = m."ownerId"');
        expect(sql.join('?')).toContain('m."ownerId" =');
        return owner === ownerId && id === modelId
          ? [
              {
                ...model,
                providerEnabled: true,
                pluginId: provider.pluginId,
                pluginVersion: 1,
                configuration: {},
              },
            ]
          : [];
      });
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    await f.service.assertPublishableConfiguration(tx, ownerId, modelId, 'text.generate');
    await expect(
      f.service.assertPublishableConfiguration(tx, otherOwnerId, modelId, 'text.generate'),
    ).rejects.toMatchObject({ code: 'MODEL_CONFIGURATION_UNAVAILABLE' });
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
