import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertProviderCapability,
  getProvider,
  listPluginManifests,
  normalizeProviderError,
  ProviderError,
} from '../src/index.js';

describe('受信任插件协议', () => {
  it('只返回精确安装版本，兼容接口不冒充图片能力', () => {
    expect(() => getProvider('unknown', '1.0.0')).toThrow(ProviderError);
    expect(() => getProvider('openai', '2.0.0')).toThrow(ProviderError);
    expect(() =>
      assertProviderCapability(getProvider('openai-compatible', '1.0.0'), 'image.generate'),
    ).toThrow(ProviderError);
    const manifests = listPluginManifests();
    manifests[0]!.capabilities.length = 0;
    expect(listPluginManifests()[0]!.capabilities).toContain('text.generate');
    expect(JSON.stringify(manifests)).not.toContain('api_key');
  });

  it('结构化参数在网络调用前被严格校验', async () => {
    const provider = getProvider('openai', '1.0.0');
    await expect(
      provider.generateText!(
        {
          modelId: 'chosen-model',
          messages: [{ role: 'user', content: '需求' }],
          parameters: { temperature: 99 },
        },
        { apiKey: 'test' },
      ),
    ).rejects.toThrow();
    await expect(
      provider.generateText!(
        {
          modelId: 'chosen-model',
          messages: [{ role: 'user', content: '需求' }],
          parameters: { secretExtraParameter: 1 },
        },
        { apiKey: 'test' },
      ),
    ).rejects.toThrow();
    await expect(
      provider.generateImages!(
        {
          modelId: 'image-model',
          prompt: '分镜',
          parameters: { background: 'transparent', outputFormat: 'jpeg' },
        },
        { apiKey: 'test' },
      ),
    ).rejects.toThrow();
    await expect(
      getProvider('openai-compatible', '1.0.0').generateText!(
        { modelId: 'chosen-model', messages: [{ role: 'user', content: '需求' }], parameters: {} },
        { apiKey: 'test' },
      ),
    ).rejects.toThrow('接口地址');
  });

  it('受理不明错误不携带原始SDK请求和密钥', () => {
    const error = normalizeProviderError({
      status: 500,
      message: 'secret-key',
      headers: { authorization: 'secret-key' },
    });
    expect(error.code).toBe('OUTCOME_UNKNOWN');
    expect(error.outcomeUnknown).toBe(true);
    expect(error.message).not.toContain('secret-key');
    expect(normalizeProviderError({ status: 401 }).outcomeUnknown).toBe(false);
  });
});

describe('官方 SDK 传输契约（本地HTTP，不使用真实凭证）', () => {
  let server: Server;
  let baseUrl: string;
  const requests: { path: string; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push({ path: request.url ?? '', body });
      response.setHeader('Content-Type', 'application/json');
      if (body.model === 'rejected-model') {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: { message: 'temporary', type: 'server_error' } }));
      } else if (request.url?.includes('images')) {
        response.end(JSON.stringify({ created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }));
      } else {
        response.end(
          JSON.stringify({
            id: 'request-1',
            object: 'chat.completion',
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: '生成的剧本' },
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
          }),
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('保留用户明确选择的模型和上下文，返回标准usage', async () => {
    const result = await getProvider('openai-compatible', '1.0.0').generateText!(
      {
        modelId: 'my-explicit-model',
        messages: [{ role: 'user', content: '只包含选定需求' }],
        parameters: { maxOutputTokens: 128 },
      },
      { apiKey: 'test-local-only', baseUrl },
    );
    expect(result.text).toBe('生成的剧本');
    expect(result.usage?.totalTokens).toBe(12);
    expect(requests.at(-1)?.body.model).toBe('my-explicit-model');
    expect(requests.at(-1)?.body.messages).toEqual([{ role: 'user', content: '只包含选定需求' }]);
  });

  it('图片返回二进制来源供宿主存储，不编造持久化资产地址', async () => {
    const result = await getProvider('openai', '1.0.0').generateImages!(
      { modelId: 'my-image-model', prompt: '分镜图', parameters: {} },
      { apiKey: 'test-local-only', baseUrl },
    );
    expect(result.images).toEqual([{ mimeType: 'image/png', base64: 'aW1hZ2U=' }]);
  });

  it('供应商5xx不会在SDK内部自动重复调用', async () => {
    const before = requests.length;
    await expect(
      getProvider('openai', '1.0.0').generateText!(
        {
          modelId: 'rejected-model',
          messages: [{ role: 'user', content: 'test' }],
          parameters: {},
        },
        { apiKey: 'test-local-only', baseUrl },
      ),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(requests.length - before).toBe(1);
  });
});
