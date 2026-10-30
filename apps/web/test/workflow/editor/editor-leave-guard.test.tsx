// @vitest-environment happy-dom
import { App, ConfigProvider } from 'antd';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Project, WorkflowResponse } from '@dramaflow/contracts';
import type { WorkflowRunState } from '../../../src/features/workflow/run/workflow-run';
import { CanvasEditor } from '../../../src/features/workflow/editor/canvas-editor';
import { useEditorLeaveGuard } from '../../../src/features/workflow/editor/navigation/use-editor-leave-guard';
import type { EditorLeaveState } from '../../../src/features/workflow/editor/navigation/editor-leave-safety';
import { ProjectWorkspace } from '../../../src/features/projects/workspace/project-workspace';
import { projectApi } from '../../../src/features/projects/project-api';

const editor = vi.hoisted(() => {
  const run: WorkflowRunState = { phase: 'idle', request: null, accepted: null, error: null };
  return { dirty: false, published: false, run, push: vi.fn(), signOut: vi.fn(async () => {}) };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: editor.push }),
  usePathname: () => `/projects/7ac10b00-33cc-4e50-9a2b-05ef764c44f4/workflows`,
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
vi.mock('../../../src/features/projects/project-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/features/projects/project-api')>()),
  projectApi: { get: vi.fn(), save: vi.fn(), remove: vi.fn() },
}));
vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  useReactFlow: () => ({ getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport: vi.fn() }),
}));
vi.mock('../../../src/features/auth/use-identity', () => ({
  useIdentity: () => ({ data: { name: '测试用户' } }),
}));
vi.mock('../../../src/features/auth/use-sign-out', () => ({
  useSignOut: () => ({ signOut: editor.signOut, signingOut: false }),
}));
vi.mock('../../../src/features/workflow/editor/draft/use-workflow-draft', () => ({
  useWorkflowDraft: () => ({
    workflowId: 'workflow-1',
    definition: { nodes: [], edges: [], inputs: [], outputs: [] },
    revision: 1,
    operation: 'idle',
    dirty: editor.dirty,
    conflict: false,
    error: null,
    edit: vi.fn(),
    save: vi.fn(),
    reload: vi.fn(),
  }),
}));
vi.mock('../../../src/features/workflow/publish/use-workflow-publish', () => ({
  useWorkflowPublish: () => ({
    publishing: false,
    currentSavedRevisionPublished: editor.published,
    latestPublishedVersion: null,
    versions: { isSuccess: true },
  }),
}));
vi.mock('../../../src/features/workflow/run/use-workflow-run', () => ({
  useWorkflowRun: () => ({
    state: editor.run,
    runStatus: { phase: 'idle', runId: null, run: null, error: null, refreshing: false },
    recovery: { checking: false, entries: [], selected: null, notice: null, storageError: false },
  }),
}));
vi.mock('../../../src/features/workflow/canvas/workflow-canvas', () => ({
  WorkflowCanvas: () => null,
}));
vi.mock('../../../src/features/workflow/run/workflow-run-controls', () => ({
  WorkflowRunControls: () => null,
}));
vi.mock('../../../src/features/workflow/publish/workflow-publish-controls', () => ({
  WorkflowPublishControls: () => null,
}));
vi.mock('../../../src/features/models/model-settings', () => ({ ModelSettings: () => null }));

const project: Project = {
  id: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  name: '测试项目',
  revision: 1,
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
};
const workflow: WorkflowResponse = {
  viewport: { x: 0, y: 0, zoom: 1 },
  metadataRevision: 1,
  id: 'workflow-1',
  projectId: project.id,
  name: '测试工作流',
  revision: 1,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  draft: { nodes: [], edges: [], inputs: [], outputs: [] },
};
function Wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </App>
    </ConfigProvider>
  );
}
function mountEditor() {
  return render(<CanvasEditor project={project} workflow={workflow} />, { wrapper: Wrapper });
}
async function attempt(destination: 'projects' | 'account' | 'logout') {
  if (destination === 'projects') fireEvent.click(screen.getByRole('button', { name: '返回项目' }));
  else {
    fireEvent.click(screen.getByRole('button', { name: '账户菜单' }));
    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: destination === 'account' ? /账户与安全/ : /退出登录/,
      }),
    );
  }
}
function unloadPrevented() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches: false,
      media,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  editor.dirty = false;
  editor.published = false;
  editor.run = { phase: 'idle', request: null, accepted: null, error: null };
  vi.clearAllMocks();
  vi.mocked(projectApi.get).mockResolvedValue(project);
});

describe('Workspace 共享导航保护真实 Canvas', () => {
  it.each([
    ['概览', 'overview'],
    ['视频', 'videos'],
    ['素材', 'assets'],
    ['设置', 'settings'],
    ['项目列表', null],
  ])('未保存草稿 → %s，取消保留编辑器，确认才导航', async (label, segment) => {
    editor.dirty = true;
    render(
      <ProjectWorkspace projectId={project.id}>
        <CanvasEditor project={project} workflow={workflow} />
      </ProjectWorkspace>,
      { wrapper: Wrapper },
    );
    const link = await screen.findByRole('link', { name: label });
    fireEvent.click(link);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(editor.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status', { name: '工作流草稿状态' }).textContent).toBe('草稿未保存');
    fireEvent.click(link);
    fireEvent.click(await screen.findByRole('button', { name: /^离\s*开$/ }));
    await waitFor(() =>
      expect(editor.push).toHaveBeenCalledExactlyOnceWith(
        segment ? `/projects/${project.id}/${segment}` : '/projects',
      ),
    );
  });

  it('保存状态变化会更新共享保护；编辑器卸载后不残留 guard', async () => {
    editor.dirty = true;
    const content = (child: ReactNode) => (
      <ProjectWorkspace projectId={project.id}>{child}</ProjectWorkspace>
    );
    const view = render(content(<CanvasEditor project={project} workflow={workflow} />), {
      wrapper: Wrapper,
    });
    await screen.findByRole('navigation');
    editor.dirty = false;
    view.rerender(content(<CanvasEditor project={project} workflow={workflow} />));
    fireEvent.click(screen.getByRole('link', { name: '视频' }));
    expect(editor.push).toHaveBeenLastCalledWith(`/projects/${project.id}/videos`);
    expect(screen.queryByRole('dialog')).toBeNull();
    editor.dirty = true;
    view.rerender(content(<CanvasEditor project={project} workflow={workflow} />));
    view.rerender(content(<main>项目概览</main>));
    fireEvent.click(screen.getByRole('link', { name: '素材' }));
    expect(editor.push).toHaveBeenLastCalledWith(`/projects/${project.id}/assets`);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(unloadPrevented()).toBe(false);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Editor 真实主动离开入口', () => {
  it.each(['projects', 'account', 'logout'] as const)(
    'dirty → %s → 取消不执行，确认后才执行',
    async (destination) => {
      editor.dirty = true;
      mountEditor();
      await attempt(destination);
      expect(await screen.findByRole('dialog')).toBeTruthy();
      expect(editor.push).not.toHaveBeenCalled();
      expect(editor.signOut).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(editor.push).not.toHaveBeenCalled();
      expect(editor.signOut).not.toHaveBeenCalled();
      await attempt(destination);
      fireEvent.click(await screen.findByRole('button', { name: /^离\s*开$/ }));
      await waitFor(() => {
        if (destination === 'logout') {
          expect(editor.signOut).toHaveBeenCalledOnce();
          expect(editor.push).not.toHaveBeenCalled();
        } else
          expect(editor.push).toHaveBeenCalledExactlyOnceWith(
            destination === 'projects' ? '/projects' : '/account',
          );
      });
    },
  );

  it.each(['projects', 'account', 'logout'] as const)(
    '已保存但未发布 → %s 直接执行',
    async (destination) => {
      mountEditor();
      await attempt(destination);
      expect(screen.queryByRole('dialog')).toBeNull();
      if (destination === 'logout') expect(editor.signOut).toHaveBeenCalledOnce();
      else
        expect(editor.push).toHaveBeenCalledExactlyOnceWith(
          destination === 'projects' ? '/projects' : '/account',
        );
    },
  );

  it('clean Draft + submitting 仍需确认，accepted pending 后可以离开', async () => {
    editor.run = { ...editor.run, phase: 'submitting' };
    const view = mountEditor();
    await attempt('projects');
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(editor.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    editor.run = {
      ...editor.run,
      phase: 'accepted',
      accepted: {
        id: 'run-1',
        workflowVersionId: 'version-1',
        invocationKey: 'key-1',
        status: 'pending',
      },
    };
    view.rerender(<CanvasEditor project={project} workflow={workflow} />);
    await attempt('projects');
    expect(editor.push).toHaveBeenCalledExactlyOnceWith('/projects');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('工作流名称未保存也使用同一保护', async () => {
    mountEditor();
    fireEvent.change(screen.getByRole('textbox', { name: '工作流名称' }), {
      target: { value: '本地修改' },
    });
    await attempt('account');
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(editor.push).not.toHaveBeenCalled();
  });
});

describe('Editor beforeunload', () => {
  const safe: EditorLeaveState = {
    draftDirty: false,
    metadataDirty: false,
    draftOperation: 'idle',
    savingMetadata: false,
    reloadingMetadata: false,
    publishing: false,
    run: { phase: 'idle', request: null, accepted: null, error: null },
  };
  it('safe 不阻止卸载，unsafe 阻止；恢复 safe 或卸载组件后解除', () => {
    const hook = renderHook((state) => useEditorLeaveGuard(state), {
      initialProps: safe,
      wrapper: Wrapper,
    });
    expect(unloadPrevented()).toBe(false);
    hook.rerender({ ...safe, draftDirty: true });
    expect(unloadPrevented()).toBe(true);
    hook.rerender(safe);
    expect(unloadPrevented()).toBe(false);
    hook.rerender({ ...safe, run: { ...safe.run, phase: 'submitting' } });
    expect(unloadPrevented()).toBe(true);
    hook.unmount();
    expect(unloadPrevented()).toBe(false);
  });
});
