import { PluginRegistry } from '@dramaflow/plugins';
import { DatabaseService, ModelProviderService, SecretsService } from '../src/index.js';
import type { Prisma } from '@dramaflow/database';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

describe('发布只检查本地能力配置', () => {
  it('Plugin 未提供所需 capability 时拒绝，不解密或执行其他能力', async () => {
    const invoke = vi.fn();
    const plugins = new PluginRegistry([
      {
        id: 'test_provider',
        version: 1,
        configSchema: z.object({}).strict(),
        credentialsSchema: z.object({}).strict(),
        capabilities: [
          {
            type: 'image.generate',
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            modelSettingsSchema: z.object({}),
            invoke,
          },
        ],
      },
    ]);
    const secrets = new SecretsService();
    const decrypt = vi.spyOn(secrets, 'decrypt');
    const database = new DatabaseService();
    const service = new ModelProviderService(database, secrets, plugins);
    // SQL / 锁与权限用真实数据库 HTTP 用例验证；这里定向检查 Registry 能力分派。
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          enabled: true,
          providerEnabled: true,
          capability: 'text.generate',
          model: 'explicit-model',
          settings: {},
          pluginId: 'test_provider',
          pluginVersion: 1,
          configuration: {},
        },
      ]),
    } as unknown as Prisma.TransactionClient;
    try {
      await expect(
        service.assertPublishableConfiguration(
          tx,
          'owner',
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002',
          'text.generate',
        ),
      ).rejects.toMatchObject({ code: 'MODEL_CONFIGURATION_INVALID' });
      expect(decrypt).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await database.onModuleDestroy();
    }
  });
});
