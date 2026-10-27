import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeCatalogApi } from '../src/features/workflow/node-catalog/node-catalog-api';
const entry = {
  id: 'product-one',
  metadata: { name: '产品操作' },
  category: 'data',
  exposure: 'public',
  target: { type: 'test.action', version: 1 },
  creation: { inputs: { text: { type: 'constant', value: '默认输入' } } },
};
function respond(body: unknown, status = 200) {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());
describe('独立 Node Catalog Entry API 客户端', () => {
  it('认证请求独立端点，保留多个共用 Runtime target 的产品条目', async () => {
    const values = [entry, { ...entry, id: 'product-two' }];
    const fetch = respond(values);
    await expect(nodeCatalogApi.list()).resolves.toEqual(values);
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/workflow/node-catalog',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });
  it('拒绝重复 Entry ID、非法 exposure、旧 Manifest 响应及服务端实现', async () => {
    for (const value of [
      [entry, entry],
      [{ ...entry, exposure: 'unknown' }],
      [{ ...entry, execute: 'code' }],
      [{ type: 'test.action', version: 1 }],
    ]) {
      respond(value);
      await expect(nodeCatalogApi.list()).rejects.toThrow('服务器响应格式');
    }
    respond([]);
    await expect(nodeCatalogApi.list()).resolves.toEqual([]);
    respond({ message: '请先登录' }, 401);
    await expect(nodeCatalogApi.list()).rejects.toMatchObject({ status: 401 });
  });
});
