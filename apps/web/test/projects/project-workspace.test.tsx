// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, ConfigProvider } from 'antd';
import type { AnchorHTMLAttributes } from 'react';
import type { Project, WorkflowResponse } from '@dramaflow/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectPage from '../../src/app/projects/[id]/page';
import ProjectLayout from '../../src/app/projects/[id]/layout';
import OverviewPage from '../../src/app/projects/[id]/overview/page';
import VideosPage from '../../src/app/projects/[id]/videos/page';
import AssetsPage from '../../src/app/projects/[id]/assets/page';
import WorkflowsPage from '../../src/app/projects/[id]/workflows/page';
import SettingsPage from '../../src/app/projects/[id]/settings/page';
import { projectApi, projectKeys } from '../../src/features/projects/project-api';
import { workflowApi } from '../../src/features/workflow/workflow-api';
import { videoApi } from '../../src/features/videos/api/video-api';
import { ApiError } from '../../src/lib/http';

const navigation = vi.hoisted(() => ({
  pathname: '',
  push: vi.fn(),
  replace: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  redirect: navigation.redirect,
}));
// 组件测试只适配 Next 的导航事件，业务页面、加载和离开保护使用真实实现。
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
  projectApi: { get: vi.fn(), save: vi.fn(), remove: vi.fn() },
}));
vi.mock('../../src/features/workflow/workflow-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/workflow/workflow-api')>()),
  workflowApi: { get: vi.fn(), initialize: vi.fn() },
}));
vi.mock('../../src/features/videos/api/video-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/videos/api/video-api')>()),
  videoApi: { list: vi.fn() },
}));
vi.mock('../../src/features/workflow/editor/canvas-editor', () => ({
  CanvasEditor: ({ project, workflow }: { project: Project; workflow: WorkflowResponse }) => (
    <main aria-label="工作流画布">
      {project.name} · {workflow.name} · 修订 {workflow.revision}
    </main>
  ),
}));

const project: Project = {
  id: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  name: '视频创作测试',
  revision: 1,
  viewport: { x: 40, y: 20, zoom: 1.2 },
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
};
const workflow: WorkflowResponse = {
  id: 'workflow-1',
  projectId: project.id,
  name: '原有工作流',
  revision: 3,
  draft: { nodes: [], edges: [], inputs: [], outputs: [] },
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
};
const base = `/projects/${project.id}`;
const routes = [
  { segment: 'overview', label: '概览', page: OverviewPage, heading: '项目概览' },
  { segment: 'videos', label: '视频', page: VideosPage, heading: '视频' },
  { segment: 'assets', label: '素材', page: AssetsPage, heading: '素材' },
  { segment: 'workflows', label: '工作流', page: WorkflowsPage, heading: null },
  { segment: 'settings', label: '设置', page: SettingsPage, heading: '项目设置' },
];

async function mount(segment = 'overview', id = project.id) {
  navigation.pathname = `/projects/${id}/${segment}`;
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const page = routes.find((route) => route.segment === segment)!.page;
  const layout = await ProjectLayout({ params: Promise.resolve({ id }), children: page() });
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <QueryClientProvider client={cache}>{layout}</QueryClientProvider>
      </App>
    </ConfigProvider>,
  );
  return { ...view, cache };
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
  vi.mocked(projectApi.get).mockReset().mockResolvedValue(project);
  vi.mocked(projectApi.save).mockReset().mockResolvedValue({ revision: 2 });
  vi.mocked(workflowApi.get).mockReset().mockResolvedValue(workflow);
  vi.mocked(workflowApi.initialize).mockReset().mockResolvedValue(workflow);
  vi.mocked(videoApi.list).mockReset().mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Project Workspace 路由与导航', () => {
  it('Project 默认入口等待动态参数后重定向到概览', async () => {
    await ProjectPage({ params: Promise.resolve({ id: project.id }) });
    expect(navigation.redirect).toHaveBeenCalledExactlyOnceWith(`${base}/overview`);
    expect(projectApi.get).not.toHaveBeenCalled();
    expect(workflowApi.initialize).not.toHaveBeenCalled();
  });

  it.each(routes)('直接打开 /$segment 恢复对应页面和选中导航', async ({ segment, heading }) => {
    await mount(segment);
    const nav = await screen.findByRole('navigation', { name: '项目工作空间' });
    for (const route of routes) {
      const link = within(nav).getByRole('link', { name: route.label });
      expect(link.getAttribute('href')).toBe(`${base}/${route.segment}`);
      expect(link.getAttribute('aria-current')).toBe(route.segment === segment ? 'page' : null);
    }
    expect(screen.getByText('视频创作项目')).toBeTruthy();
    if (heading) expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    else expect(await screen.findByRole('main', { name: '工作流画布' })).toBeTruthy();
    expect(projectApi.get).toHaveBeenCalledExactlyOnceWith(project.id);
    expect(workflowApi.get).toHaveBeenCalledTimes(segment === 'workflows' ? 1 : 0);
    expect(workflowApi.initialize).not.toHaveBeenCalled();
  });

  it('导航与概览入口进入指定路由，点击当前页面不重复导航', async () => {
    await mount();
    const nav = await screen.findByRole('navigation');
    for (const { segment, label } of routes) {
      fireEvent.click(within(nav).getByRole('link', { name: label }));
      if (segment !== 'overview')
        expect(navigation.push).toHaveBeenLastCalledWith(`${base}/${segment}`);
      else expect(navigation.push).not.toHaveBeenCalled();
    }
    fireEvent.click(screen.getByRole('link', { name: '打开工作流画布' }));
    expect(navigation.push).toHaveBeenLastCalledWith(`${base}/workflows`);
    fireEvent.click(screen.getByRole('link', { name: '项目列表' }));
    expect(navigation.push).toHaveBeenLastCalledWith('/projects');
    expect(workflowApi.get).not.toHaveBeenCalled();
  });

  it.each([['assets', '素材管理尚未开放']])(
    '%s 展示诚实空状态且没有创建操作',
    async (segment, message) => {
      await mount(segment);
      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /上传|新建视频|生成视频/ })).toBeNull();
      expect(workflowApi.get).not.toHaveBeenCalled();
      expect(workflowApi.initialize).not.toHaveBeenCalled();
    },
  );

  it('非法项目地址不发出项目请求或展示页面内容', async () => {
    await mount('overview', 'invalid');
    expect(await screen.findByText('项目地址无效')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(projectApi.get).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])('项目 %s 时不展示 Workspace 或加载工作流', async (status) => {
    vi.mocked(projectApi.get).mockRejectedValue(new ApiError('项目不存在或无权访问', status));
    await mount('workflows');
    expect(await screen.findByText('项目不存在或无权访问')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(workflowApi.get).not.toHaveBeenCalled();
  });

  it('后台项目读取临时失败保留当前页，明确拒绝访问则隐藏内容', async () => {
    const { cache } = await mount('settings');
    const input = await screen.findByRole('textbox', { name: '项目名称' });
    fireEvent.change(input, { target: { value: '本地未保存' } });
    vi.mocked(projectApi.get).mockRejectedValue(new Error('网络暂时断开'));
    await act(() => cache.invalidateQueries({ queryKey: projectKeys.detail(project.id) }));
    expect(await screen.findByText('项目信息暂时无法刷新，当前编辑仍保留')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '项目名称' })).toBe(input);
    expect((input as HTMLInputElement).value).toBe('本地未保存');
    vi.mocked(projectApi.get).mockRejectedValue(new ApiError('无权访问', 403));
    await act(() => cache.invalidateQueries({ queryKey: projectKeys.detail(project.id) }));
    expect(await screen.findByText('无权访问')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('Workflows 承接原 Canvas 加载协议', () => {
  it('传递原有项目和工作流，不创建新草稿', async () => {
    await mount('workflows');
    expect((await screen.findByRole('main', { name: '工作流画布' })).textContent).toBe(
      '视频创作测试 · 原有工作流 · 修订 3',
    );
    expect(workflowApi.get).toHaveBeenCalledExactlyOnceWith(project.id);
    expect(workflowApi.initialize).not.toHaveBeenCalled();
  });

  it('缺少工作流只在用户明确操作后初始化', async () => {
    vi.mocked(workflowApi.get).mockRejectedValue(new ApiError('尚未初始化', 404));
    await mount('workflows');
    const initialize = await screen.findByRole('button', { name: '初始化工作流' });
    expect(workflowApi.initialize).not.toHaveBeenCalled();
    fireEvent.click(initialize);
    expect(await screen.findByRole('main', { name: '工作流画布' })).toBeTruthy();
    expect(workflowApi.initialize).toHaveBeenCalledExactlyOnceWith(project.id);
  });

  it('读取失败可以重试且不误当成缺少工作流', async () => {
    vi.mocked(workflowApi.get).mockRejectedValueOnce(new ApiError('暂时不可用', 503));
    await mount('workflows');
    fireEvent.click(await screen.findByRole('button', { name: '重新读取工作流' }));
    expect(await screen.findByRole('main', { name: '工作流画布' })).toBeTruthy();
    expect(workflowApi.initialize).not.toHaveBeenCalled();
  });
});

describe('项目设置复用原项目操作', () => {
  it('改名使用原保存协议并保留视口，同步 Workspace 项目名称', async () => {
    await mount('settings');
    fireEvent.change(await screen.findByRole('textbox', { name: '项目名称' }), {
      target: { value: '新的项目名' },
    });
    fireEvent.submit(screen.getByRole('button', { name: '保存项目信息' }).closest('form')!);
    await waitFor(() =>
      expect(projectApi.save).toHaveBeenCalledExactlyOnceWith(project.id, {
        revision: 1,
        name: '新的项目名',
        viewport: project.viewport,
      }),
    );
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('新的项目名'));
    expect(workflowApi.initialize).not.toHaveBeenCalled();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it('未保存名称通过共享导航离开时确认，取消保留当前编辑', async () => {
    await mount('settings');
    const input = await screen.findByRole('textbox', { name: '项目名称' });
    fireEvent.change(input, { target: { value: '未保存' } });
    const overview = within(screen.getByRole('navigation')).getByRole('link', { name: '概览' });
    fireEvent.click(overview);
    expect(await screen.findByRole('dialog', { name: '确认离开项目设置？' })).toBeTruthy();
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((input as HTMLInputElement).value).toBe('未保存');
    fireEvent.click(overview);
    fireEvent.click(await screen.findByRole('button', { name: /^离\s*开$/ }));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledExactlyOnceWith(`${base}/overview`),
    );
    expect(projectApi.save).not.toHaveBeenCalled();
  });

  it('冲突阻止覆盖，确认重读使用服务器名称和修订', async () => {
    vi.mocked(projectApi.save).mockRejectedValue(new ApiError('修订冲突', 409));
    await mount('settings');
    fireEvent.change(await screen.findByRole('textbox', { name: '项目名称' }), {
      target: { value: '本地名称' },
    });
    fireEvent.submit(screen.getByRole('button', { name: '保存项目信息' }).closest('form')!);
    expect(await screen.findByText('项目信息已在其他页面更新')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '保存项目信息' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    vi.mocked(projectApi.get).mockResolvedValue({ ...project, name: '服务器项目', revision: 4 });
    fireEvent.click(screen.getByRole('button', { name: '重新读取项目信息' }));
    fireEvent.click(await screen.findByRole('button', { name: '读取服务器项目信息' }));
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: '项目名称' }) as HTMLInputElement).value).toBe(
        '服务器项目',
      ),
    );
    expect(screen.getByRole('banner').textContent).toContain('服务器项目');
    expect(projectApi.save).toHaveBeenCalledTimes(1);
  });
});
