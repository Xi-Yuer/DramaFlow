// @vitest-environment happy-dom
import { App, ConfigProvider } from 'antd';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Project, WorkflowResponse } from '@dramaflow/contracts';
import type { WorkflowRunState } from '../src/features/workflow/run/workflow-run';
import { CanvasEditor } from '../src/features/workflow/editor/canvas-editor';
import { useEditorLeaveGuard } from '../src/features/workflow/editor/use-editor-leave-guard';
import type { EditorLeaveState } from '../src/features/workflow/editor/editor-leave-safety';

const editor = vi.hoisted(() => {
  const run: WorkflowRunState = { phase: 'idle', request: null, accepted: null, error: null };
  return { dirty: false, published: false, run, push: vi.fn(), signOut: vi.fn(async () => {}) };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: editor.push }) }));
vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  useReactFlow: () => ({ getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport: vi.fn() }),
}));
vi.mock('../src/features/auth/use-identity', () => ({
  useIdentity: () => ({ data: { name: '测试用户' } }),
}));
vi.mock('../src/features/auth/use-sign-out', () => ({
  useSignOut: () => ({ signOut: editor.signOut, signingOut: false }),
}));
vi.mock('../src/features/workflow/editor/use-workflow-draft', () => ({
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
vi.mock('../src/features/workflow/publish/use-workflow-publish', () => ({
  useWorkflowPublish: () => ({
    publishing: false,
    currentSavedRevisionPublished: editor.published,
    latestPublishedVersion: null,
    versions: { isSuccess: true },
  }),
}));
vi.mock('../src/features/workflow/run/use-workflow-run', () => ({
  useWorkflowRun: () => ({
    state: editor.run,
    runStatus: { phase: 'idle', runId: null, run: null, error: null, refreshing: false },
    recovery: { checking: false, entries: [], selected: null, notice: null, storageError: false },
  }),
}));
vi.mock('../src/features/workflow/canvas/workflow-canvas', () => ({ WorkflowCanvas: () => null }));
vi.mock('../src/features/workflow/run/workflow-run-controls', () => ({
  WorkflowRunControls: () => null,
}));
vi.mock('../src/features/workflow/publish/workflow-publish-controls', () => ({
  WorkflowPublishControls: () => null,
}));
vi.mock('../src/features/models/model-settings', () => ({ ModelSettings: () => null }));

const project: Project = {
  id: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  name: '测试项目',
  revision: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
};
const workflow: WorkflowResponse = {
  id: 'workflow-1',
  projectId: project.id,
  name: '测试工作流',
  revision: 1,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  draft: { nodes: [], edges: [], inputs: [], outputs: [] },
};
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>{children}</App>
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

  it('项目名称未保存也使用同一保护', async () => {
    mountEditor();
    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), {
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
    projectDirty: false,
    draftOperation: 'idle',
    savingProject: false,
    reloadingProject: false,
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
