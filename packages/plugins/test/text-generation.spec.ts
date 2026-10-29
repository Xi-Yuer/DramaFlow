import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginRegistry, TextGenerationPlugin, type InvokeCapabilityInput } from '../src/index.js';

type Provider = 'openai' | 'anthropic';
const servers: Server[] = [];
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试端口无效');
  return `http://127.0.0.1:${address.port}/v1`;
}
function invocation(provider: Provider, baseURL: string): InvokeCapabilityInput {
  return {
    pluginId: 'text_generation',
    pluginVersion: 1,
    capability: 'text.generate',
    configuration: { provider, baseURL },
    credentials: { apiKey: `test-only-${provider}-secret` },
    model: provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-20250514',
    settings: { temperature: 0.2, maxOutputTokens: 64 },
    input: { prompt: '测试提示词', system: '测试系统输入' },
  };
}
function completion(provider: Provider, text = '完整文本', stop?: string) {
  return provider === 'openai'
    ? {
        id: 'test-completion',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: stop ?? 'stop',
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }
    : {
        id: 'test-message',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text }],
        stop_reason: stop ?? 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 3 },
      };
}
const registry = () => new PluginRegistry([new TextGenerationPlugin()]);
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe.each(['openai', 'anthropic'] as const)(
  '正式 text_generation@1 / %s（真实 SDK、本机协议）',
  (provider) => {
    it('使用本次 credential 和实际协议，不读取环境默认值；并发调用不串 key', async () => {
      const received: Array<{ path?: string; key?: string | string[]; body: unknown }> = [];
      const baseURL = await listen((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
        });
        request.on('end', () => {
          received.push({
            path: request.url,
            key: request.headers[provider === 'openai' ? 'authorization' : 'x-api-key'],
            body: JSON.parse(body),
          });
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(completion(provider)));
        });
      });
      vi.stubEnv('OPENAI_API_KEY', 'unused-environment-key');
      vi.stubEnv('ANTHROPIC_API_KEY', 'unused-environment-key');
      vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:1');
      vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:1');
      const plugins = registry();
      const keys = ['first-test-only-key', 'second-test-only-key'];
      expect(
        await Promise.all(
          keys.map((apiKey) =>
            plugins.invoke({ ...invocation(provider, baseURL), credentials: { apiKey } }),
          ),
        ),
      ).toEqual([{ text: '完整文本' }, { text: '完整文本' }]);
      expect(received).toHaveLength(2);
      expect(received.map((item) => item.key).sort()).toEqual(
        keys.map((key) => (provider === 'openai' ? `Bearer ${key}` : key)).sort(),
      );
      for (const item of received) {
        expect(item.path).toBe(provider === 'openai' ? '/v1/chat/completions' : '/v1/messages');
        expect(item.body).toMatchObject({ temperature: 0.2, max_tokens: 64 });
        expect(item.body).not.toHaveProperty('stream', true);
        expect(JSON.stringify(item.body)).toContain('测试提示词');
        expect(JSON.stringify(item.body)).toContain('测试系统输入');
      }
    });

    it.each([307, 308, 401, 429, 503])(
      'HTTP %i 只有一次 POST，零 redirect target；错误只保留安全字段',
      async (status) => {
        let calls = 0;
        let targetCalls = 0;
        const targetURL = await listen((_request, response) => {
          targetCalls++;
          response.end('{}');
        });
        const baseURL = await listen((_request, response) => {
          calls++;
          response.writeHead(status, {
            'content-type': 'application/json',
            location: targetURL,
            'x-sensitive-header': 'header-marker',
          });
          response.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'api_error',
                message: `test-only-${provider}-secret 测试提示词 raw-provider-error`,
              },
            }),
          );
        });
        const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
        const error: unknown = await registry()
          .invoke(invocation(provider, baseURL))
          .catch((value: unknown) => value);
        expect(calls).toBe(1);
        expect(targetCalls).toBe(0);
        expect(error).toMatchObject({
          code: 'CAPABILITY_INVOCATION_FAILED',
          status,
          outcome: status >= 400 && status < 500 ? 'rejected' : 'outcome_unknown',
        });
        expect(Object.keys(error as Error).sort()).toEqual([
          'category',
          'code',
          'name',
          'outcome',
          'status',
        ]);
        for (const secret of [
          `test-only-${provider}-secret`,
          '测试提示词',
          'raw-provider-error',
          'header-marker',
          baseURL,
        ])
          expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
        expect(log).not.toHaveBeenCalled();
        expect(warning).not.toHaveBeenCalled();
      },
    );

    it.each(['empty', 'length', 'filter', 'key', 'tool'])('拒绝无效输出 %s', async (mode) => {
      const payload = completion(
        provider,
        mode === 'empty' ? ' \n ' : mode === 'key' ? `test-only-${provider}-secret` : '未完成文本',
        mode === 'length'
          ? provider === 'openai'
            ? 'length'
            : 'max_tokens'
          : mode === 'filter'
            ? provider === 'openai'
              ? 'content_filter'
              : 'refusal'
            : undefined,
      );
      if (mode === 'tool') {
        if (payload.choices) payload.choices[0]!.finish_reason = 'tool_calls';
        else payload.stop_reason = 'tool_use';
      }
      const baseURL = await listen((_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(payload));
      });
      await expect(registry().invoke(invocation(provider, baseURL))).rejects.toMatchObject({
        code: 'CAPABILITY_OUTPUT_INVALID',
      });
    });

    it('响应正文停滞与显式取消均受 deadline 约束，不重发请求', async () => {
      let calls = 0;
      const baseURL = await listen((_request, response) => {
        calls++;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{');
      });
      await expect(
        registry().invoke({
          ...invocation(provider, baseURL),
          configuration: { provider, baseURL, timeoutMs: 100 },
        }),
      ).rejects.toMatchObject({ code: 'CAPABILITY_INVOCATION_FAILED', outcome: 'outcome_unknown' });
      expect(calls).toBe(1);
      const controller = new AbortController();
      const pending = registry().invoke({
        ...invocation(provider, baseURL),
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(calls).toBe(2));
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: 'CAPABILITY_INVOCATION_FAILED',
        outcome: 'outcome_unknown',
      });
      expect(calls).toBe(2);
    });
  },
);

it('OpenAI 非空 refusal 不被 SDK 统一文本转换吞掉', async () => {
  const baseURL = await listen((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        ...completion('openai'),
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '不应输出', refusal: '拒绝' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });
  await expect(registry().invoke(invocation('openai', baseURL))).rejects.toMatchObject({
    code: 'CAPABILITY_OUTPUT_INVALID',
  });
});

it('SDK 忽略参数时安全失败，warning 不经过全局 logger', async () => {
  const baseURL = await listen((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(completion('openai')));
  });
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await expect(
    registry().invoke({ ...invocation('openai', baseURL), model: 'o3' }),
  ).rejects.toMatchObject({ code: 'CAPABILITY_SETTINGS_INVALID' });
  expect(warning).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

it('目录与调用复用严格 Schema，未知厂商、凭证缺失、越界参数在网络前拒绝', async () => {
  const plugins = registry();
  expect(plugins.listConfigurable()).toMatchObject([
    {
      id: 'text_generation',
      version: 1,
      configurationSchema: { properties: { provider: { enum: ['openai', 'anthropic'] } } },
    },
  ]);
  const request = invocation('openai', 'http://127.0.0.1:1/v1');
  for (const configuration of [
    { baseURL: 'https://api.openai.com/v1' },
    { provider: 'other', baseURL: 'https://example.test/v1' },
    { provider: 'openai', baseURL: 'https://user:secret@example.test/v1' },
  ])
    await expect(plugins.invoke({ ...request, configuration })).rejects.toMatchObject({
      code: 'CAPABILITY_CONFIGURATION_INVALID',
    });
  await expect(plugins.invoke({ ...request, credentials: {} })).rejects.toMatchObject({
    code: 'CAPABILITY_CREDENTIALS_INVALID',
  });
  for (const settings of [
    {},
    { maxOutputTokens: 64, temperature: 2 },
    { maxOutputTokens: 64, unsupported: true },
  ])
    await expect(plugins.invoke({ ...request, settings })).rejects.toMatchObject({
      code: 'CAPABILITY_SETTINGS_INVALID',
    });
});
