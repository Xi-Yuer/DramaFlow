import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelApi } from '../src/features/models/model-api';

const projectId = '7ac10b00-33cc-4e50-9a2b-05ef764c44f4';
const provider = {
  id: '7ac10b00-33cc-4e50-9a2b-05ef764c44f5',
  projectId,
  name: '供应商',
  pluginId: 'custom',
  pluginVersion: 1,
  providerDefinitionId: null,
  configuration: { endpoint: 'https://custom.example' },
  enabled: true,
  createdAt: '2026-10-21T00:00:00.000Z',
};
const marker = 'test-secret-must-not-be-cached';
afterEach(() => vi.unstubAllGlobals());
function fetchResponse(body: unknown, status = 200) {
  const fetch = vi.fn().mockResolvedValue(Response.json(body, { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
describe('模型管理 HTTP 安全边界', () => {
  it('使用同源正式 API 遍历分页，不隐藏后续供应商', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ items: [provider], nextCursor: provider.id }))
      .mockResolvedValueOnce(
        Response.json({ items: [{ ...provider, id: projectId }], nextCursor: null }),
      );
    vi.stubGlobal('fetch', fetch);
    expect(await modelApi.providers(projectId)).toHaveLength(2);
    expect(fetch.mock.calls[1][0]).toBe(
      `/api/v1/projects/${projectId}/providers?cursor=${provider.id}`,
    );
    expect(fetch.mock.calls[0][1].credentials).toBe('same-origin');
  });
  it('服务端重复游标明确报错，不返回假完整结果或无限请求', async () => {
    const fetch = fetchResponse({ items: [], nextCursor: provider.id });
    await expect(modelApi.providers(projectId)).rejects.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('创建只返回安全 DTO，凭证仅进入明确的 POST 请求体', async () => {
    const fetch = fetchResponse(provider);
    const body = {
      name: provider.name,
      pluginId: provider.pluginId,
      pluginVersion: provider.pluginVersion,
      configuration: provider.configuration,
    };
    const result = await modelApi.createProvider(projectId, {
      ...body,
      credentials: { token: marker },
    });
    expect(result).toEqual(provider);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(fetch.mock.calls[0][1].body).toContain(marker);
  });
  it('目录创建只提交服务标识和凭证，不提交插件或地址', async () => {
    const fetch = fetchResponse({ ...provider, providerDefinitionId: 'openai' });
    const result = await modelApi.createCatalogProvider(projectId, {
      name: 'OpenAI',
      providerDefinitionId: 'openai',
      credentials: { apiKey: marker },
    });
    expect(result.providerDefinitionId).toBe('openai');
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(fetch.mock.calls[0][0]).toBe(`/api/v1/projects/${projectId}/providers/catalog`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    const body = String(fetch.mock.calls[0][1].body);
    expect(body).toContain(marker);
    expect(body).toContain('"providerDefinitionId":"openai"');
    expect(body).not.toContain('pluginId');
    expect(body).not.toContain('baseURL');
  });
  it('轮换仅接受 204，无响应体或 Secret 读取操作', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    expect(
      await modelApi.replaceCredentials(projectId, provider.id, { token: marker }),
    ).toBeUndefined();
    expect(fetch.mock.calls[0][0]).toBe(
      `/api/v1/projects/${projectId}/providers/${provider.id}/credentials`,
    );
    expect(fetch.mock.calls[0][1].method).toBe('PUT');
  });
  it.each([400, 403, 404, 409, 500])(
    '错误正文和未知字段即使回显凭证也不会保留在错误或 details（%s）',
    async (status) => {
      const fetch = fetchResponse({ message: marker, details: { credentials: marker } }, status);
      const error = await modelApi
        .createProvider(projectId, {
          name: '供应商',
          pluginId: 'custom',
          pluginVersion: 1,
          configuration: {},
          credentials: { token: marker },
        })
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ status, details: undefined });
      expect(String(error)).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain(marker);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('拒绝带 credential 的错误读取响应，不能进入成功数据缓存', async () => {
    fetchResponse({ items: [{ ...provider, credentials: { token: marker } }], nextCursor: null });
    const error = await modelApi.providers(projectId).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 200, details: undefined });
    expect(JSON.stringify(error)).not.toContain(marker);
  });
  it('轮换失败也不会保留原始响应或自动重试', async () => {
    const fetch = fetchResponse({ message: marker }, 503);
    const error = await modelApi
      .replaceCredentials(projectId, provider.id, { token: marker })
      .catch((error: unknown) => error);
    expect(JSON.stringify(error)).not.toContain(marker);
    expect(error).toMatchObject({ status: 503, details: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
