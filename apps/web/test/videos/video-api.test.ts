import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Video } from '@dramaflow/contracts';
import { videoApi, videoKeys } from '../../src/features/videos/api/video-api';
import { ApiError } from '../../src/lib/http';

const projectId = '00000000-0000-4000-8000-000000000001';
const video: Video = {
  id: '00000000-0000-4000-8000-000000000002',
  projectId,
  name: '雨夜来信',
  status: 'draft',
  revision: 1,
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
};
const base = `/api/v1/projects/${projectId}/videos`;
afterEach(() => vi.unstubAllGlobals());

describe('Video Web API 协议', () => {
  it('列表和详情路径固定项目作用域，分页游标编码后传递', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ items: [video], nextCursor: null }))
      .mockResolvedValueOnce(Response.json(video));
    vi.stubGlobal('fetch', fetcher);
    expect((await videoApi.list(projectId, 'cursor')).items).toEqual([video]);
    expect(await videoApi.get(projectId, video.id)).toEqual(video);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      `${base}?cursor=cursor`,
      `${base}/${video.id}`,
    ]);
    expect(videoKeys.detail('other-project', video.id)).not.toEqual(
      videoKeys.detail(projectId, video.id),
    );
  });
  it('创建只发送名称，保存发送名称、生命周期和 revision，删除接受 204', async () => {
    const receipt = { revision: 2, updatedAt: video.updatedAt };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(video))
      .mockResolvedValueOnce(Response.json(receipt))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    await videoApi.create(projectId, '雨夜来信');
    const input = { name: '新名称', status: 'active' as const, revision: 1 };
    expect(await videoApi.save(projectId, video.id, input)).toEqual(receipt);
    expect(await videoApi.remove(projectId, video.id)).toBeNull();
    expect(fetcher.mock.calls[0]).toEqual([
      base,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: '雨夜来信' }),
        credentials: 'same-origin',
      }),
    ]);
    expect(fetcher.mock.calls[1]).toEqual([
      `${base}/${video.id}`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(input) }),
    ]);
    expect(fetcher.mock.calls[2]).toEqual([
      `${base}/${video.id}`,
      expect.objectContaining({ method: 'DELETE' }),
    ]);
  });
  it('错误和不符合身份协议的响应不能成为成功作品', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ message: '作品不存在或无权访问' }, { status: 404 }))
        .mockResolvedValueOnce(Response.json({ ...video, status: 'rendering' })),
    );
    await expect(videoApi.get(projectId, video.id)).rejects.toMatchObject({ status: 404 });
    await expect(videoApi.get(projectId, video.id)).rejects.toBeInstanceOf(ApiError);
  });
});
