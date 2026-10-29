import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunnableLambda } from '@langchain/core/runnables';
import {
  OpenAICompatiblePlugin,
  PluginRegistry,
  type InvokeCapabilityInput,
} from '../src/index.js';

const servers: Server[] = [];
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试 HTTP 端口无效');
  return `http://127.0.0.1:${address.port}/v1`;
}

function invocation(baseURL: string): InvokeCapabilityInput {
  return {
    pluginId: 'openai_compatible',
    pluginVersion: 1,
    capability: 'text.generate',
    configuration: { baseURL },
    credentials: { apiKey: 'test-only-api-key' },
    // 普通 ChatOpenAI 会按 codex 名称改用 Responses；此适配器固定明确的 Completions 协议。
    model: 'custom-codex-text',
    settings: { temperature: 0.4, maxOutputTokens: 120 },
    input: { prompt: '写一句场景描述', system: '只输出中文' },
  };
}

function complete(response: ServerResponse) {
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({
      id: 'test-completion',
      object: 'chat.completion',
      created: 1,
      model: 'custom-codex-text',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '落日映红了窗棂。' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
    }),
  );
}

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

describe('OpenAI-compatible 真实本机 HTTP 协议（非真实模型）', () => {
  it('明确 endpoint/model/key，传递显式输入与有界设置，固定 Completions 协议', async () => {
    let observed: { url?: string; authorization?: string; body: string } | undefined;
    const baseURL = await listen((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        observed = { url: request.url, authorization: request.headers.authorization, body };
        complete(response);
      });
    });
    vi.stubEnv('OPENAI_API_KEY', 'unused-environment-secret');
    vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:1/never');
    const registry = new PluginRegistry([new OpenAICompatiblePlugin()]);
    await expect(registry.invoke(invocation(baseURL))).resolves.toEqual({
      text: '落日映红了窗棂。',
    });
    expect(observed?.url).toBe('/v1/chat/completions');
    expect(observed?.authorization).toBe('Bearer test-only-api-key');
    expect(JSON.parse(observed!.body)).toMatchObject({
      model: 'custom-codex-text',
      temperature: 0.4,
      max_tokens: 120,
      stream: false,
      messages: [
        { role: 'system', content: '只输出中文' },
        { role: 'user', content: '写一句场景描述' },
      ],
    });
    expect(observed!.body).not.toContain('api-key');
    await expect(
      registry.invoke({ ...invocation(baseURL), configuration: {} }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CONFIGURATION_INVALID' });
    await expect(
      registry.invoke({ ...invocation(baseURL), credentials: {} }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CREDENTIALS_INVALID' });
    await expect(registry.invoke({ ...invocation(baseURL), model: '' })).rejects.toMatchObject({
      code: 'CAPABILITY_MODEL_INVALID',
    });
  });

  it.each([500, 429, 401])('HTTP %i 只请求一次，安全错误不保留响应内密钥', async (status) => {
    let calls = 0;
    const baseURL = await listen((_request, response) => {
      calls++;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { message: 'test-only-api-key Authorization', type: 'provider_error' },
        }),
      );
    });
    const error = await new PluginRegistry([new OpenAICompatiblePlugin()])
      .invoke(invocation(baseURL))
      .catch((value: unknown) => value);
    expect(calls).toBe(1);
    expect(error).toMatchObject({
      code: 'CAPABILITY_INVOCATION_FAILED',
      status,
      outcome: status < 500 ? 'rejected' : 'outcome_unknown',
    });
    expect(error).not.toHaveProperty('cause');
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain('test-only-api-key');
  });

  it.each([
    { name: '空文本', content: '', finishReason: 'stop' },
    { name: '空白文本', content: ' \n ', finishReason: 'stop' },
    { name: '截断结果', content: '未完成的文本', finishReason: 'length' },
    { name: '内容过滤', content: '不可消费的结果', finishReason: 'content_filter' },
    { name: '拒绝结果', content: '拒绝内容', finishReason: 'stop', refusal: 'policy' },
    {
      name: '非文本内容块',
      content: [{ type: 'text', text: '非本轮字符串契约' }],
      finishReason: 'stop',
    },
  ])('$name 不得被误判为文本生成成功', async (sample) => {
    const baseURL = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'invalid-text',
          object: 'chat.completion',
          created: 1,
          model: 'custom-codex-text',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: sample.content,
                ...('refusal' in sample ? { refusal: sample.refusal } : {}),
              },
              finish_reason: sample.finishReason,
            },
          ],
        }),
      );
    });
    await expect(
      new PluginRegistry([new OpenAICompatiblePlugin()]).invoke(invocation(baseURL)),
    ).rejects.toMatchObject({ code: 'CAPABILITY_OUTPUT_INVALID' });
  });

  it('有限超时和 AbortSignal 不重发受理结果不明的模型调用', async () => {
    let calls = 0;
    const baseURL = await listen(() => {
      calls++;
    });
    const registry = new PluginRegistry([new OpenAICompatiblePlugin()]);
    const timed = registry
      .invoke({ ...invocation(baseURL), configuration: { baseURL, timeoutMs: 1000 } })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(await timed).toMatchObject({
      category: 'timeout',
      code: 'CAPABILITY_INVOCATION_FAILED',
      outcome: 'outcome_unknown',
    });
    expect(calls).toBe(1);
    const controller = new AbortController();
    const pending = registry.invoke({ ...invocation(baseURL), signal: controller.signal });
    await vi.waitFor(() => expect(calls).toBe(2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'CAPABILITY_INVOCATION_FAILED',
      outcome: 'outcome_unknown',
    });
    expect(calls).toBe(2);
  });

  it('收到响应头后正文停滞，仍受完整调用 deadline 约束', async () => {
    let calls = 0;
    const baseURL = await listen((_request, response) => {
      calls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"id":"unfinished');
    });
    await expect(
      new PluginRegistry([new OpenAICompatiblePlugin()]).invoke({
        ...invocation(baseURL),
        configuration: { baseURL, timeoutMs: 1000 },
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_INVOCATION_FAILED', outcome: 'outcome_unknown' });
    expect(calls).toBe(1);
  });

  it.each([
    'ftp://host/v1',
    'https://user:secret@host/v1',
    'https://host/v1?apiKey=secret',
    'https://host/v1#secret',
  ])('拒绝含隐式认证/参数或错误协议的 endpoint %s', async (baseURL) => {
    await expect(
      new PluginRegistry([new OpenAICompatiblePlugin()]).invoke(invocation(baseURL)),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CONFIGURATION_INVALID' });
  });

  it('隔离父级 callbacks 与环境 tracing，不把请求/供应商错误发送给 trace 或日志', async () => {
    let traceCalls = 0;
    let modelCalls = 0;
    const tracingURL = await listen((_request, response) => {
      traceCalls++;
      response.end('{}');
    });
    const baseURL = await listen((_request, response) => {
      modelCalls++;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'test-only-api-key' } }));
    });
    vi.stubEnv('LANGSMITH_TRACING', 'true');
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'true');
    vi.stubEnv('LANGSMITH_ENDPOINT', tracingURL);
    vi.stubEnv('LANGCHAIN_ENDPOINT', tracingURL);
    vi.stubEnv('LANGSMITH_API_KEY', 'test-only-tracing-key');
    vi.stubEnv('OPENAI_LOG', 'debug');
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    for (const log of logs) log.mockImplementation(() => undefined);
    const registry = new PluginRegistry([new OpenAICompatiblePlugin()]);
    const handleChatModelStart = vi.fn();
    // 外层 Runnable 仅用于构造真实父级 Callback Context；不允许继承到供应商调用。
    vi.stubEnv('LANGSMITH_TRACING', 'false');
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
    await expect(
      RunnableLambda.from(async () => {
        vi.stubEnv('LANGSMITH_TRACING', 'true');
        vi.stubEnv('LANGCHAIN_TRACING_V2', 'true');
        return registry.invoke(invocation(baseURL));
      }).invoke({}, { callbacks: [{ handleChatModelStart }] }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_INVOCATION_FAILED' });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(modelCalls).toBe(1);
    expect(traceCalls).toBe(0);
    expect(handleChatModelStart).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('全局详细日志会泄露原始异常时明确禁止执行', async () => {
    vi.stubEnv('LANGCHAIN_VERBOSE', 'true');
    await expect(
      new PluginRegistry([new OpenAICompatiblePlugin()]).invoke(
        invocation('http://127.0.0.1:1/v1'),
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DEBUG_MODE_UNSUPPORTED' });
  });
});
