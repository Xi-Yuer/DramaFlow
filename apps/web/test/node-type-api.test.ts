import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeTypeApi } from '../src/features/workflow/node-catalog/node-type-api';

const manifest = {
  type: 'test.text',
  version: 1,
  executionKind: 'action',
  metadata: {
    name: '文本样例',
    category: 'ai',
    catalog: { exposure: 'internal', category: 'advanced' },
  },
  inputs: [],
  outputs: [],
  config: [],
};

afterEach(() => vi.unstubAllGlobals());

function respond(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('节点类型目录客户端', () => {
  it('通过现有认证 API 获取目录，接受真实空目录', async () => {
    const fetchMock = respond([]);
    await expect(nodeTypeApi.list()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/workflow/node-types',
      expect.objectContaining({
        credentials: 'same-origin',
      }),
    );
  });

  it('验证可公开 JSON Manifest，不接受服务端实现或重复类型版本', async () => {
    respond([manifest]);
    await expect(nodeTypeApi.list()).resolves.toEqual([manifest]);
    respond([{ ...manifest, compile: 'server-code' }]);
    await expect(nodeTypeApi.list()).rejects.toThrow('服务器响应格式');
    respond([
      {
        ...manifest,
        metadata: { ...manifest.metadata, catalog: { exposure: 'invalid', category: 'advanced' } },
      },
    ]);
    await expect(nodeTypeApi.list()).rejects.toThrow('服务器响应格式');
    respond([manifest, manifest]);
    await expect(nodeTypeApi.list()).rejects.toThrow('服务器响应格式');
  });

  it('认证失败明确传播，不能静默降级为空目录', async () => {
    respond({ message: '请先登录' }, 401);
    await expect(nodeTypeApi.list()).rejects.toMatchObject({ status: 401, message: '请先登录' });
  });
});
