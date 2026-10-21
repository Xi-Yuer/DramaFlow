import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CapabilityError, PluginRegistry, type ProviderPlugin } from '../src/index.js';

function fixture(version = 1): ProviderPlugin {
  return {
    id: 'chosen_provider',
    version,
    configSchema: z.object({ endpoint: z.string() }).strict(),
    credentialsSchema: z.object({ token: z.string().min(1) }).strict(),
    capabilities: ['text.generate', 'text.summarize'].map((type) => ({
      type,
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outputSchema: z.object({ text: z.string() }).strict(),
      modelSettingsSchema: z.object({ temperature: z.number().min(0).max(2) }).strict(),
      async invoke(input, context) {
        return { text: `${version}:${type}:${context.model}:${JSON.stringify(input)}` };
      },
    })),
  };
}

const request = () => ({
  pluginId: 'chosen_provider',
  pluginVersion: 1,
  capability: 'text.generate',
  configuration: { endpoint: 'https://explicit.example/v1' },
  credentials: { token: 'test-secret' },
  model: 'explicit-model',
  settings: { temperature: 0.7 },
  input: { prompt: '明确输入' },
});

describe('受信任静态 PluginRegistry', () => {
  it('按插件整数版本精确查找，支持多个能力且不选择默认提供者', async () => {
    const registry = new PluginRegistry([fixture(1), fixture(2)]);
    await expect(registry.invoke(request())).resolves.toEqual({
      text: '1:text.generate:explicit-model:{"prompt":"明确输入"}',
    });
    await expect(
      registry.invoke({ ...request(), pluginVersion: 2, capability: 'text.summarize' }),
    ).resolves.toHaveProperty('text', '2:text.summarize:explicit-model:{"prompt":"明确输入"}');
    expect(() => registry.get('chosen_provider', 3)).toThrowError(CapabilityError);
    expect(() => registry.get('chosen_provider', 3)).toThrow('插件版本不可用');
    expect(() => registry.getCapability('chosen_provider', 1, 'image.generate')).toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_NOT_AVAILABLE' }),
    );
    expect(() => registry.register(fixture(1))).toThrowError(
      expect.objectContaining({ code: 'PLUGIN_ALREADY_REGISTERED' }),
    );
    expect(() => new PluginRegistry([{ ...fixture(), version: 1.1 }])).toThrowError(
      expect.objectContaining({ code: 'PLUGIN_REGISTRATION_INVALID' }),
    );
    const duplicated = fixture();
    expect(
      () =>
        new PluginRegistry([
          {
            ...duplicated,
            capabilities: [duplicated.capabilities[0]!, duplicated.capabilities[0]!],
          },
        ]),
    ).toThrowError(expect.objectContaining({ code: 'PLUGIN_REGISTRATION_INVALID' }));
  });

  it.each([
    ['configuration', {}, 'CAPABILITY_CONFIGURATION_INVALID'],
    ['credentials', { token: '' }, 'CAPABILITY_CREDENTIALS_INVALID'],
    ['model', '  ', 'CAPABILITY_MODEL_INVALID'],
    ['settings', { temperature: 10 }, 'CAPABILITY_SETTINGS_INVALID'],
    ['input', { prompt: 1 }, 'CAPABILITY_INPUT_INVALID'],
  ])('解析 %s 失败时不进入适配器且不保留验证原文', async (key, value, code) => {
    const plugin = fixture();
    const invoke = vi.fn();
    const registry = new PluginRegistry([
      { ...plugin, capabilities: [{ ...plugin.capabilities[0]!, invoke }] },
    ]);
    await expect(registry.invoke({ ...request(), [key]: value })).rejects.toMatchObject({ code });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('配置和凭证必须是 JSON object，阻止非 JSON transform 与输出契约漂移', async () => {
    const plugin = fixture();
    const capability = plugin.capabilities[0]!;
    const registry = new PluginRegistry([
      {
        ...plugin,
        capabilities: [
          {
            ...capability,
            async invoke() {
              return { text: 3 };
            },
          },
        ],
      },
    ]);
    await expect(registry.invoke(request())).rejects.toMatchObject({
      code: 'CAPABILITY_OUTPUT_INVALID',
    });
    await expect(
      registry.invoke({ ...request(), credentials: { token: 'secret', date: new Date() } }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CREDENTIALS_INVALID' });
    const transformed = new PluginRegistry([
      { ...plugin, configSchema: z.object({ endpoint: z.string().transform(() => new Date()) }) },
    ]);
    await expect(transformed.invoke(request())).rejects.toMatchObject({
      code: 'CAPABILITY_CONFIGURATION_INVALID',
    });
  });

  it('原始供应商异常不能携带 secret、response、stack 或 cause 越过能力边界', async () => {
    const plugin = fixture();
    const registry = new PluginRegistry([
      {
        ...plugin,
        capabilities: [
          {
            ...plugin.capabilities[0]!,
            async invoke() {
              throw Object.assign(new Error('Authorization: test-secret'), {
                status: 401,
                response: { apiKey: 'test-secret' },
              });
            },
          },
        ],
      },
    ]);
    const error = await registry.invoke(request()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CapabilityError);
    expect(error).toMatchObject({
      code: 'CAPABILITY_INVOCATION_FAILED',
      status: 401,
      outcome: 'rejected',
    });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('response');
    expect(String(error)).not.toContain('test-secret');
    expect(JSON.stringify(error)).not.toContain('test-secret');
    expect(error instanceof Error ? error.stack : '').not.toContain('Authorization');
  });
});
