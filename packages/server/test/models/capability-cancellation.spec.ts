import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PluginRegistry } from '@dramaflow/plugins';
import { WorkflowExecutionCancellation } from '@dramaflow/workflow';
import { WorkflowCapabilitiesFactory } from '../../src/models/workflow-capabilities.factory.js';
import type { DatabaseService } from '../../src/database/database.service.js';
import type { SecretsService } from '../../src/secrets/secrets.service.js';

describe('正式 ModelConfiguration → Plugin signal 桥接', () => {
  it('沿用正式模型 / 凭证查询，同一 signal 进入 Plugin，取消 reason 不被安全错误投影吞掉', async () => {
    const scope = new WorkflowExecutionCancellation('run');
    const called = vi.fn();
    const registry = new PluginRegistry([
      {
        id: 'test.signal',
        version: 1,
        configSchema: z.object({}),
        credentialsSchema: z.object({}),
        capabilities: [
          {
            type: 'text.generate',
            inputSchema: z.object({ prompt: z.string() }),
            outputSchema: z.object({ text: z.string() }),
            modelSettingsSchema: z.object({}),
            invoke: async (_input, context) => {
              called(context.signal);
              return new Promise((_resolve, reject) =>
                context.signal!.addEventListener(
                  'abort',
                  () => reject(Error('SDK abort wrapper')),
                  { once: true },
                ),
              );
            },
          },
        ],
      },
    ]);
    const model = {
      enabled: true,
      model: 'deterministic',
      settings: {},
      provider: {
        enabled: true,
        ownerId: 'owner',
        pluginId: 'test.signal',
        pluginVersion: 1,
        configuration: {},
        encryptedCredentials: 'encrypted',
      },
    };
    const findFirst = vi.fn().mockResolvedValue(model);
    const db = {
      client: {
        workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run' }) },
        modelConfiguration: { findFirst },
      },
    } as unknown as DatabaseService;
    const decrypt = vi.fn().mockReturnValue('{}');
    const factory = new WorkflowCapabilitiesFactory(
      db,
      { decrypt } as unknown as SecretsService,
      registry,
    );
    const pending = factory
      .forRun('owner', 'project', 'run')
      .invoke(
        'text.generate',
        { modelConfigurationId: '00000000-0000-4000-8000-000000000001', input: { prompt: 'test' } },
        { signal: scope.signal },
      );
    await vi.waitFor(() => expect(called).toHaveBeenCalledExactlyOnceWith(scope.signal));
    scope.request();
    await expect(pending).rejects.toBe(scope.signal.reason);
    expect(decrypt).toHaveBeenCalledWith('encrypted', 'owner');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: 'owner', capability: 'text.generate' }),
      }),
    );
  });
});
