import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ANTHROPIC_API_BASE_URL,
  ANTHROPIC_PROVIDER_ID,
  OPENAI_API_BASE_URL,
  OPENAI_PROVIDER_ID,
  PluginRegistry,
  ProviderCatalog,
  TextGenerationPlugin,
  createOfficialProviderCatalog,
} from '../src/index.js';

const servers: Server[] = [];
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试端口无效');
  return `http://127.0.0.1:${address.port}/v1`;
}
function completion(provider: 'openai' | 'anthropic') {
  return provider === 'openai'
    ? {
        id: 'test-completion',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: '目录文本' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
    : {
        id: 'test-message',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [{ type: 'text', text: '目录文本' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
}
const registry = () => new PluginRegistry([new TextGenerationPlugin()]);
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe('官方 Provider Catalog', () => {
  it('只发布 OpenAI 与 Anthropic，映射同一 text_generation@1，目录不含实现细节或凭证', () => {
    const catalog = createOfficialProviderCatalog(registry());
    const items = catalog.list();
    expect(items.map((item) => item.id)).toEqual([ANTHROPIC_PROVIDER_ID, OPENAI_PROVIDER_ID]);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    for (const item of items) {
      expect(item.available).toBe(true);
      expect(item.capabilities).toEqual([{ type: 'text.generate', name: '文本生成' }]);
      expect(item.credentialFields).toEqual([
        { key: 'apiKey', required: true, minLength: 1, maxLength: 4096 },
      ]);
    }
    const published = JSON.stringify(items);
    expect(published).not.toMatch(
      /text_generation|pluginId|pluginVersion|baseURL|api\.openai\.com|api\.anthropic\.com|vercel|ai-sdk|secret/i,
    );
    const openai = catalog.materialize(OPENAI_PROVIDER_ID, {
      credentials: { apiKey: 'openai-test-only' },
    });
    const anthropic = catalog.materialize(ANTHROPIC_PROVIDER_ID, {
      credentials: { apiKey: 'anthropic-test-only' },
    });
    expect(openai.pluginId).toBe('text_generation');
    expect(anthropic.pluginId).toBe(openai.pluginId);
    expect(openai.pluginVersion).toBe(1);
    expect(anthropic.pluginVersion).toBe(1);
    expect(openai.providerDefinitionId).not.toBe(anthropic.providerDefinitionId);
    expect(openai.configuration).toEqual({
      provider: 'openai',
      baseURL: OPENAI_API_BASE_URL,
      timeoutMs: 60000,
    });
    expect(anthropic.configuration).toEqual({
      provider: 'anthropic',
      baseURL: ANTHROPIC_API_BASE_URL,
      timeoutMs: 60000,
    });
  });

  it('用户不能改写官方 endpoint 或协议，未知 Provider 不能物化', () => {
    const catalog = createOfficialProviderCatalog(registry());
    expect(() =>
      catalog.materialize(OPENAI_PROVIDER_ID, {
        configuration: { baseURL: 'https://evil.example/v1' },
        credentials: { apiKey: 'test-only' },
      }),
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_DEFINITION_CONFIGURATION_INVALID' }));
    expect(() => catalog.materialize('deepseek', { credentials: { apiKey: 'test-only' } })).toThrow(
      expect.objectContaining({ code: 'PROVIDER_DEFINITION_NOT_AVAILABLE' }),
    );
  });

  it('物化后的配置可以直接驱动现有 OpenAI / Anthropic 插件调用', async () => {
    const plugins = registry();
    const catalog = createOfficialProviderCatalog(plugins);
    for (const provider of ['openai', 'anthropic'] as const) {
      const received: Array<{ path?: string; key?: string | string[] }> = [];
      const baseURL = await listen((request, response) => {
        request.setEncoding('utf8');
        request.on('data', () => undefined);
        request.on('end', () => {
          received.push({
            path: request.url,
            key: request.headers[provider === 'openai' ? 'authorization' : 'x-api-key'],
          });
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(completion(provider)));
        });
      });
      const materialized = catalog.materialize(provider, {
        credentials: { apiKey: 'catalog-key' },
      });
      await expect(
        plugins.invoke({
          pluginId: materialized.pluginId,
          pluginVersion: materialized.pluginVersion,
          capability: 'text.generate',
          configuration: { ...materialized.configuration, baseURL },
          credentials: materialized.credentials,
          model: provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-20250514',
          settings: { temperature: 0.2, maxOutputTokens: 32 },
          input: { prompt: '目录提示词' },
        }),
      ).resolves.toEqual({ text: '目录文本' });
      expect(received).toEqual([
        {
          path: provider === 'openai' ? '/v1/chat/completions' : '/v1/messages',
          key: provider === 'openai' ? 'Bearer catalog-key' : 'catalog-key',
        },
      ]);
    }
  });

  it('定义必须指向已注册插件，且用户配置不能覆盖实现字段', () => {
    const plugins = registry();
    expect(
      () =>
        new ProviderCatalog(plugins, [
          {
            id: 'openai',
            displayName: 'OpenAI',
            available: true,
            pluginId: 'missing_plugin',
            pluginVersion: 1,
            capabilities: ['text.generate'],
            implementationConfiguration: {},
            configurationSchema: z.object({}).strict(),
          },
        ]),
    ).toThrow(expect.objectContaining({ code: 'PLUGIN_NOT_AVAILABLE' }));
    expect(
      () =>
        new ProviderCatalog(plugins, [
          {
            id: 'openai',
            displayName: 'OpenAI',
            available: true,
            pluginId: 'text_generation',
            pluginVersion: 1,
            capabilities: ['text.generate'],
            implementationConfiguration: { provider: 'openai', baseURL: OPENAI_API_BASE_URL },
            configurationSchema: z.object({ baseURL: z.string() }).strict(),
          },
        ]),
    ).toThrow(expect.objectContaining({ code: 'PLUGIN_REGISTRATION_INVALID' }));
  });
});
