import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CapabilityError,
  OpenAICompatiblePlugin,
  PluginRegistry,
  TextGenerationPlugin,
  type InvokeCapabilityInput,
} from '../src/index.js';

const servers: Server[] = [];
const implementations = [
  { pluginId: 'text_generation', provider: 'openai' },
  { pluginId: 'text_generation', provider: 'anthropic' },
  { pluginId: 'openai_compatible', provider: 'openai' },
] as const;

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

describe.each(implementations)('$pluginId / $provider 成功文本的凭证边界', (implementation) => {
  async function fixture(text: (credential: string, otherCredential: string) => string) {
    const credential = `test-only-${randomUUID()}`;
    const otherCredential = `test-only-other-${randomUUID()}`;
    vi.stubEnv('OPENAI_API_KEY', otherCredential);
    vi.stubEnv('ANTHROPIC_API_KEY', otherCredential);
    let calls = 0;
    let usedInvocationCredential = false;
    const server = createServer((request, response) => {
      calls++;
      const header =
        request.headers[implementation.provider === 'anthropic' ? 'x-api-key' : 'authorization'];
      const usedCredential = typeof header === 'string' ? header.replace(/^Bearer /, '') : '';
      usedInvocationCredential = usedCredential === credential;
      const content = text(usedCredential, otherCredential);
      const payload =
        implementation.provider === 'anthropic'
          ? {
              id: 'test-message',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-20250514',
              content: [{ type: 'text', text: content }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 2, output_tokens: 3 },
            }
          : {
              id: 'test-completion',
              object: 'chat.completion',
              created: 1,
              model: 'gpt-4o',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
            };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试端口无效');
    const request: InvokeCapabilityInput = {
      pluginId: implementation.pluginId,
      pluginVersion: 1,
      capability: 'text.generate',
      configuration: {
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        ...(implementation.pluginId === 'text_generation'
          ? { provider: implementation.provider }
          : {}),
      },
      // Schema 修剪后才是实际发送的凭证；检查不能误用原始表单值或环境默认值。
      credentials: { apiKey: `  ${credential}  ` },
      model: implementation.provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o',
      settings: { maxOutputTokens: 64 },
      input: { prompt: '只用于本机协议测试' },
    };
    const plugin =
      implementation.pluginId === 'text_generation'
        ? new TextGenerationPlugin()
        : new OpenAICompatiblePlugin();
    const registry = new PluginRegistry([plugin]);
    return {
      credential,
      otherCredential,
      invoke: (direct: boolean) =>
        direct ? plugin.capabilities[0]!.invoke(request.input, request) : registry.invoke(request),
      assertSingleRequest: () => {
        expect(calls).toBe(1);
        expect(usedInvocationCredential).toBe(true);
      },
    };
  }

  it('正常成功文本原样返回，只有一次 Provider 请求', async () => {
    const text = '落日映红了窗棂。';
    const f = await fixture(() => text);
    await expect(f.invoke(false)).resolves.toEqual({ text });
    f.assertSingleRequest();
  });

  it('api_key、token 等字样及其他凭证不触发本次凭证检查', async () => {
    const f = await fixture(
      (_credential, otherCredential) =>
        `说明 api_key、token、credential 的含义：${otherCredential}`,
    );
    const expected = `说明 api_key、token、credential 的含义：${f.otherCredential}`;
    await expect(f.invoke(false)).resolves.toEqual({ text: expected });
    f.assertSingleRequest();
  });

  it.each([false, true])('拒绝正文中嵌入实际凭证，不泄漏或重发（直接调用=%s）', async (direct) => {
    const f = await fixture((credential) => `正文前缀 ${credential} 正文后缀`);
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    for (const log of logs) log.mockImplementation(() => undefined);
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    let failure: unknown;
    let returned = false;
    try {
      await f.invoke(direct);
      returned = true;
    } catch (error) {
      failure = error;
    }
    // 失败时只输出布尔断言，不让测试框架打印含虚构凭证的成功正文。
    expect(returned).toBe(false);
    expect(failure instanceof CapabilityError).toBe(true);
    if (!(failure instanceof CapabilityError)) throw new Error('应返回平台安全错误');
    expect(failure.code).toBe('CAPABILITY_OUTPUT_INVALID');
    expect('cause' in failure).toBe(false);
    const diagnostic = `${String(failure)} ${JSON.stringify(failure)} ${failure.stack ?? ''}`;
    expect(diagnostic.includes(f.credential)).toBe(false);
    expect(diagnostic.includes('正文前缀')).toBe(false);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    f.assertSingleRequest();
  });
});
