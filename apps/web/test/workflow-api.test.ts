import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowApi } from '../src/features/workflow/workflow-api';
import { ApiError } from '../src/lib/http';

const draft = { inputs: [], nodes: [], edges: [], outputs: [] };
const workflow = {
  id: 'workflow-1',
  projectId: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  name: '默认工作流',
  revision: 3,
  draft,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
};
afterEach(() => vi.unstubAllGlobals());
function mockResponse(body: unknown, status = 200) {
  const fetch = vi.fn().mockResolvedValue(Response.json(body, { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('Workflow 编辑 HTTP 边界', () => {
  it('GET 保留真实身份、草稿和独立 revision，并使用同源会话', async () => {
    const fetch = mockResponse(workflow);
    expect(await workflowApi.get(workflow.projectId)).toEqual(workflow);
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${workflow.projectId}/workflow`,
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });
  it('GET 404 传播给显式初始化 UI，不自动 POST', async () => {
    const fetch = mockResponse({ message: '工作流不存在' }, 404);
    await expect(workflowApi.get(workflow.projectId)).rejects.toMatchObject({ status: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
  });
  it('初始化是独立 POST 操作', async () => {
    const fetch = mockResponse(workflow);
    await workflowApi.initialize(workflow.projectId);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });
  it('PUT 完整草稿与 expectedRevision，空配置草稿不执行发布校验', async () => {
    const fetch = mockResponse({ revision: 4 });
    const input = { expectedRevision: 3, definition: draft };
    expect(await workflowApi.saveDraft(workflow.id, input)).toEqual({ revision: 4 });
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/workflows/workflow-1/draft',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(input) }),
    );
  });
  it.each([409, 403, 404, 500])('失败保留 HTTP 状态且不重试（%s）', async (status) => {
    const fetch = mockResponse({ message: '保存失败' }, status);
    await expect(
      workflowApi.saveDraft(workflow.id, { expectedRevision: 3, definition: draft }),
    ).rejects.toMatchObject({ status, message: '保存失败' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('拒绝不符合契约的成功响应，不能误报已保存', async () => {
    mockResponse({ revision: 0 });
    await expect(
      workflowApi.saveDraft(workflow.id, { expectedRevision: 3, definition: draft }),
    ).rejects.toBeInstanceOf(ApiError);
  });
  it('网络失败不转为成功或空草稿', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('网络中断')));
    await expect(workflowApi.get(workflow.projectId)).rejects.toThrow('网络中断');
  });
});
