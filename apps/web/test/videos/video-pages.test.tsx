// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, ConfigProvider } from 'antd';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { Project, Video } from '@dramaflow/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VideosPage from '../../src/app/projects/[id]/videos/page';
import VideoPage from '../../src/app/projects/[id]/videos/[videoId]/page';
import { ProjectWorkspace } from '../../src/features/projects/workspace/project-workspace';
import { projectApi } from '../../src/features/projects/project-api';
import { videoApi, videoKeys } from '../../src/features/videos/api/video-api';
import { ApiError } from '../../src/lib/http';

const navigation = vi.hoisted(() => ({ pathname: '', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
}));
vi.mock('next/link', () => ({
  default: ({
    onNavigate,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    onNavigate?: (event: { preventDefault(): void }) => void;
  }) => (
    <a
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onNavigate?.({ preventDefault() {} });
      }}
    />
  ),
}));
vi.mock('../../src/features/auth/use-identity', () => ({
  useIdentity: () => ({ data: { id: 'user-1', name: '测试用户' }, isPending: false }),
}));
vi.mock('../../src/features/auth/account-menu', () => ({
  AccountMenuButton: () => <button>账户菜单</button>,
}));
vi.mock('../../src/features/projects/project-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/projects/project-api')>()),
  projectApi: { get: vi.fn() },
}));
vi.mock('../../src/features/videos/api/video-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/videos/api/video-api')>()),
  videoApi: { list: vi.fn(), create: vi.fn(), get: vi.fn(), save: vi.fn(), remove: vi.fn() },
}));
const project: Project = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '视频项目',
  revision: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
};
const video: Video = {
  id: '00000000-0000-4000-8000-000000000002',
  projectId: project.id,
  name: '雨夜来信',
  status: 'draft',
  revision: 1,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
};
const base = `/projects/${project.id}/videos`;

async function mount(id?: string) {
  navigation.pathname = id ? `${base}/${id}` : base;
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const content = (children: ReactNode) => (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <QueryClientProvider client={cache}>
          <ProjectWorkspace projectId={project.id}>{children}</ProjectWorkspace>
        </QueryClientProvider>
      </App>
    </ConfigProvider>
  );
  const page = id ? await VideoPage({ params: Promise.resolve({ videoId: id }) }) : VideosPage();
  const view = render(content(page));
  return {
    ...view,
    cache,
    navigate: async (id?: string) => {
      navigation.pathname = id ? `${base}/${id}` : base;
      view.rerender(
        content(id ? await VideoPage({ params: Promise.resolve({ videoId: id }) }) : VideosPage()),
      );
    },
  };
}
function submitVideo() {
  fireEvent.submit(screen.getByRole('button', { name: '保存视频信息' }).closest('form')!);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      media,
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.mocked(projectApi.get).mockReset().mockResolvedValue(project);
  vi.mocked(videoApi.list).mockReset().mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(videoApi.get).mockReset().mockResolvedValue(video);
  vi.mocked(videoApi.create).mockReset().mockResolvedValue(video);
  vi.mocked(videoApi.save)
    .mockReset()
    .mockResolvedValue({ revision: 2, updatedAt: '2026-10-30T01:00:00.000Z' });
  vi.mocked(videoApi.remove).mockReset().mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Project Videos 真实页面装配', () => {
  it('空状态创建作品后进入独立详情；返回列表展示已创建作品', async () => {
    const view = await mount();
    expect(await screen.findByText('还没有视频作品')).toBeTruthy();
    expect(videoApi.list).toHaveBeenCalledExactlyOnceWith(project.id, undefined);
    fireEvent.click(screen.getByRole('button', { name: '创建第一个视频' }));
    fireEvent.change(await screen.findByRole('textbox', { name: '视频名称' }), {
      target: { value: ' 雨夜来信 ' },
    });
    vi.mocked(videoApi.list).mockResolvedValue({ items: [video], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: '创建并进入' }));
    await waitFor(() =>
      expect(videoApi.create).toHaveBeenCalledExactlyOnceWith(project.id, '雨夜来信'),
    );
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledExactlyOnceWith(`${base}/${video.id}`),
    );
    await view.navigate(video.id);
    expect(await screen.findByRole('heading', { name: video.name })).toBeTruthy();
    expect(
      within(screen.getByRole('navigation'))
        .getByRole('link', { name: '视频' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.getByText(video.id)).toBeTruthy();
    await view.navigate();
    const link = await screen.findByRole('link', { name: video.name });
    expect(link.getAttribute('href')).toBe(`${base}/${video.id}`);
    expect(screen.queryByText('还没有视频作品')).toBeNull();
    fireEvent.click(link);
    expect(navigation.push).toHaveBeenLastCalledWith(`${base}/${video.id}`);
  });
  it('创建失败保留名称与错误，不假装创建成功或跳转', async () => {
    vi.mocked(videoApi.create).mockRejectedValue(new Error('网络断开'));
    await mount();
    await screen.findByText('还没有视频作品');
    fireEvent.click(screen.getByRole('button', { name: '新建视频' }));
    fireEvent.change(await screen.findByRole('textbox', { name: '视频名称' }), {
      target: { value: '待创建' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建并进入' }));
    expect(await screen.findByText('视频创建未完成')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '视频名称' }) as HTMLInputElement).value).toBe(
      '待创建',
    );
    expect(navigation.push).not.toHaveBeenCalled();
    expect(videoApi.create).toHaveBeenCalledTimes(1);
  });
  it('列表读取失败不是空项目；下一页也只读取当前项目', async () => {
    vi.mocked(videoApi.list).mockRejectedValueOnce(new Error('暂时不可用'));
    await mount();
    expect(await screen.findByText('视频列表读取失败')).toBeTruthy();
    expect(screen.queryByText('还没有视频作品')).toBeNull();
    vi.mocked(videoApi.list)
      .mockResolvedValueOnce({ items: [video], nextCursor: 'next' })
      .mockResolvedValueOnce({
        items: [{ ...video, id: '00000000-0000-4000-8000-000000000003', name: '第二作品' }],
        nextCursor: null,
      });
    fireEvent.click(screen.getByRole('button', { name: /^重\s*试$/ }));
    fireEvent.click(await screen.findByRole('button', { name: '加载更多视频' }));
    expect(await screen.findByRole('link', { name: '第二作品' })).toBeTruthy();
    expect(videoApi.list).toHaveBeenLastCalledWith(project.id, 'next');
  });
});

describe('Video 详情身份、编辑与删除', () => {
  it('直接打开详情读取当前项目的 Video，支持改名及手动生命周期', async () => {
    await mount(video.id);
    const input = await screen.findByRole('textbox', { name: '视频名称' });
    expect(videoApi.get).toHaveBeenCalledExactlyOnceWith(project.id, video.id);
    fireEvent.change(input, { target: { value: ' 新作品名 ' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '生命周期' }));
    fireEvent.click(
      await screen.findByText('进行中', { selector: '.ant-select-item-option-content' }),
    );
    submitVideo();
    await waitFor(() =>
      expect(videoApi.save).toHaveBeenCalledExactlyOnceWith(project.id, video.id, {
        revision: 1,
        name: '新作品名',
        status: 'active',
      }),
    );
    expect(await screen.findByRole('heading', { name: '新作品名' })).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('新作品名');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });
  it('未保存名称受共享导航保护，取消仍在原作品', async () => {
    await mount(video.id);
    const input = await screen.findByRole('textbox', { name: '视频名称' });
    fireEvent.change(input, { target: { value: '本地修改' } });
    fireEvent.click(screen.getByRole('link', { name: '返回视频列表' }));
    expect(await screen.findByRole('dialog', { name: '确认离开视频作品？' })).toBeTruthy();
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((input as HTMLInputElement).value).toBe('本地修改');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });
  it('保存期间继续编辑，只确认提交快照且不重复提交', async () => {
    let resolve!: (result: { revision: number; updatedAt: string }) => void;
    vi.mocked(videoApi.save).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await mount(video.id);
    const input = await screen.findByRole('textbox', { name: '视频名称' });
    fireEvent.change(input, { target: { value: '提交快照' } });
    submitVideo();
    await waitFor(() =>
      expect(videoApi.save).toHaveBeenCalledExactlyOnceWith(project.id, video.id, {
        name: '提交快照',
        status: 'draft',
        revision: 1,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /保存视频信息/ }));
    fireEvent.change(input, { target: { value: '请求期间修改' } });
    await act(async () => {
      resolve({ revision: 2, updatedAt: video.updatedAt });
    });
    expect(videoApi.save).toHaveBeenCalledTimes(1);
    expect((input as HTMLInputElement).value).toBe('请求期间修改');
    expect(screen.getByRole('heading', { name: '提交快照' })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '保存视频信息' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  it('冲突保留编辑并阻止覆盖，明确重读恢复最新身份', async () => {
    vi.mocked(videoApi.save).mockRejectedValue(new ApiError('修订冲突', 409));
    await mount(video.id);
    fireEvent.change(await screen.findByRole('textbox', { name: '视频名称' }), {
      target: { value: '本地名称' },
    });
    submitVideo();
    expect(await screen.findByText('视频信息已在其他页面更新')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '保存视频信息' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    vi.mocked(videoApi.get).mockResolvedValue({ ...video, name: '服务器作品', revision: 4 });
    fireEvent.click(screen.getByRole('button', { name: '重新读取视频信息' }));
    fireEvent.click(await screen.findByRole('button', { name: '读取服务器视频信息' }));
    expect(await screen.findByRole('heading', { name: '服务器作品' })).toBeTruthy();
    expect(videoApi.save).toHaveBeenCalledTimes(1);
  });
  it('网络失败不误报已保存，不自动重放', async () => {
    vi.mocked(videoApi.save).mockRejectedValue(new Error('网络断开'));
    await mount(video.id);
    fireEvent.change(await screen.findByRole('textbox', { name: '视频名称' }), {
      target: { value: '待保存' },
    });
    submitVideo();
    expect(await screen.findByText('视频操作未完成')).toBeTruthy();
    expect(screen.getByRole('heading', { name: video.name })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '视频名称' }) as HTMLInputElement).value).toBe(
      '待保存',
    );
    expect(videoApi.save).toHaveBeenCalledTimes(1);
  });
  it('冲突后明确重读发现作品已删除，隐藏旧身份和编辑入口', async () => {
    vi.mocked(videoApi.save).mockRejectedValue(new ApiError('修订冲突', 409));
    await mount(video.id);
    fireEvent.change(await screen.findByRole('textbox', { name: '视频名称' }), {
      target: { value: '本地修改' },
    });
    submitVideo();
    fireEvent.click(await screen.findByRole('button', { name: '重新读取视频信息' }));
    vi.mocked(videoApi.get).mockRejectedValue(new ApiError('作品不存在或无权访问', 404));
    fireEvent.click(await screen.findByRole('button', { name: '读取服务器视频信息' }));
    expect(await screen.findByText('视频作品无法打开')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '视频名称' })).toBeNull();
    expect(screen.queryByText(video.id)).toBeNull();
  });
  it('删除前确认；失败保留详情，成功才返回列表并刷新缓存', async () => {
    vi.mocked(videoApi.remove)
      .mockRejectedValueOnce(new Error('删除暂时失败'))
      .mockResolvedValue(null);
    const view = await mount(video.id);
    view.cache.setQueryData(videoKeys.list(project.id), {
      pages: [{ items: [video], nextCursor: null }],
      pageParams: [undefined],
    });
    fireEvent.click(await screen.findByRole('button', { name: '删除视频' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(videoApi.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^删\s*除$/ }));
    expect(await screen.findByText('视频操作未完成')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(navigation.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '删除视频' }));
    fireEvent.click(await screen.findByRole('button', { name: /^删\s*除$/ }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledExactlyOnceWith(base));
    expect(videoApi.remove).toHaveBeenLastCalledWith(project.id, video.id);
    await view.navigate();
    expect(await screen.findByText('还没有视频作品')).toBeTruthy();
  });
  it.each([403, 404])('越权、跨项目或不存在 Video (%s) 不展示身份或编辑入口', async (status) => {
    vi.mocked(videoApi.get).mockRejectedValue(new ApiError('作品不存在或无权访问', status));
    await mount(video.id);
    expect(await screen.findByText('视频作品无法打开')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '视频名称' })).toBeNull();
    expect(screen.queryByText(video.id)).toBeNull();
  });
  it('非法 Video 路由不请求 API', async () => {
    await mount('invalid');
    expect(await screen.findByText('视频地址无效')).toBeTruthy();
    expect(videoApi.get).not.toHaveBeenCalled();
  });
  it('临时后台错误保留编辑；明确拒绝访问隐藏作品', async () => {
    const { cache } = await mount(video.id);
    const input = await screen.findByRole('textbox', { name: '视频名称' });
    fireEvent.change(input, { target: { value: '本地编辑' } });
    vi.mocked(videoApi.get).mockRejectedValue(new Error('网络断开'));
    await act(() => cache.invalidateQueries({ queryKey: videoKeys.detail(project.id, video.id) }));
    expect(await screen.findByText('视频信息暂时无法刷新，当前编辑仍保留')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('本地编辑');
    vi.mocked(videoApi.get).mockRejectedValue(new ApiError('无权访问', 403));
    await act(() => cache.invalidateQueries({ queryKey: videoKeys.detail(project.id, video.id) }));
    expect(await screen.findByText('视频作品无法打开')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
